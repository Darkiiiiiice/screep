/**
 * Console logging with a budget.
 *
 * `console.log` is not free: it costs CPU to format and the engine truncates
 * excessive output per tick, so an unthrottled log in a hot path both burns the
 * 20 ms budget and destroys the signal by flooding. Everything here is built
 * around emitting little and saying something.
 *
 * Two throttles, for two different failure modes:
 *   - per-signature: a repeated identical message (a retry loop) collapses to
 *     one line per N ticks.
 *   - per-tick total: a broad failure (every creep erroring) cannot exceed a
 *     fixed line count, so the tick still has CPU for actual work.
 *
 * State lives in the heap rather than in module scope: it is cross-tick scratch
 * data, which is exactly what the heap is for, and it keeps every piece of
 * kernel state resettable and inspectable in one place.
 */
import { heapGet } from './heap';

/** Max console lines emitted in a single tick. */
const TICK_LINE_BUDGET = 8;

/** Ticks before the same signature may be reported again. */
const SIGNATURE_INTERVAL = 25;

/**
 * Ticks a signature is remembered for throttling. Bounded so the table cannot
 * grow without limit in a long-lived runtime — entries older than this can no
 * longer suppress anything anyway.
 */
const SIGNATURE_MEMORY = SIGNATURE_INTERVAL * 4;

export type Level = 'info' | 'warn' | 'error';

interface LogState {
  tick: number;
  linesThisTick: number;
  /** signature -> last tick it was emitted. */
  lastSeen: Record<string, number>;
  /** Lines dropped this tick, reported as a single summary line. */
  suppressed: number;
}

function logState(): LogState {
  const s = heapGet<LogState>('log', () => ({
    tick: Game.time,
    linesThisTick: 0,
    lastSeen: {},
    suppressed: 0,
  }));

  if (s.tick !== Game.time) {
    s.tick = Game.time;
    s.linesThisTick = 0;
    s.suppressed = 0;
    s.lastSeen = pruneSignatures(s.lastSeen);
  }
  return s;
}

/**
 * Drop signatures that can no longer suppress anything.
 *
 * Plain object rather than a Map: it is small, string-keyed, and rebuilt
 * wholesale once per tick.
 */
function pruneSignatures(seen: Record<string, number>): Record<string, number> {
  const kept: Record<string, number> = {};
  for (const [signature, tick] of Object.entries(seen)) {
    if (Game.time - tick < SIGNATURE_MEMORY) kept[signature] = tick;
  }
  return kept;
}

/**
 * Emit a line, subject to both throttles.
 *
 * @param signature stable identity for this message. Two calls with the same
 *   signature are treated as the same problem regardless of the numbers in the
 *   text — pass the operation name, not the interpolated message.
 */
export function log(level: Level, signature: string, message: string): void {
  const s = logState();
  const last = s.lastSeen[signature];

  if (last !== undefined && Game.time - last < SIGNATURE_INTERVAL) {
    s.suppressed += 1;
    return;
  }

  if (s.linesThisTick >= TICK_LINE_BUDGET) {
    s.suppressed += 1;
    return;
  }

  s.lastSeen[signature] = Game.time;
  s.linesThisTick += 1;

  const prefix = level === 'info' ? '' : `[${level}] `;
  console.log(`[${Game.time}] ${prefix}${message}`);
}

/**
 * Report and clear the suppression count.
 *
 * Called at the end of the tick so the log stays honest: a silent log with no
 * summary would read as "nothing happened" when lines were in fact dropped.
 */
export function flushLogSummary(): void {
  const s = logState();
  if (s.suppressed === 0) return;

  const dropped = s.suppressed;
  s.suppressed = 0;
  console.log(`[${Game.time}] (+${dropped} suppressed)`);
}
