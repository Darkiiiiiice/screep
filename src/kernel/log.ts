/**
 * Console logging with a budget.
 *
 * `console.log` is not free: it costs CPU to format and the engine truncates
 * excessive output per tick, so an unthrottled log in a hot path both burns the
 * 20 ms budget and destroys the signal by flooding.
 *
 * Two throttles, for two different failure modes:
 *   - per-signature: a repeated identical message collapses to one line per N
 *     ticks.
 *   - per-tick total: a broad failure (every creep erroring) cannot exceed a
 *     fixed line count, so the tick still has CPU for actual work.
 *
 * Design note, learned from watching the live console: an earlier version
 * printed a suppression summary once per tick, which made the summary itself the
 * flood — one `(+1 suppressed)` line every tick, more noise than the messages it
 * replaced. The count is now carried on the *next* emission of that signature,
 * so a suppressed run costs nothing and the report arrives attached to the line
 * it describes.
 */
import { heapGet } from './heap';

/** Max console lines emitted in a single tick. */
const TICK_LINE_BUDGET = 8;

/**
 * Ticks before the same signature may be reported again.
 *
 * Note the wall-clock meaning: the measured tick rate is ~4 s on this shard, so
 * 25 ticks is roughly 100 seconds. That is deliberately slow for an idle
 * economy — it makes the log a heartbeat rather than a stream — and it is why
 * the budget must also be spent on genuinely new information.
 */
const SIGNATURE_INTERVAL = 25;

/**
 * Ticks a signature is remembered for throttling. Bounded so the table cannot
 * grow without limit in a long-lived runtime — entries older than this can no
 * longer suppress anything anyway.
 */
const SIGNATURE_MEMORY = SIGNATURE_INTERVAL * 4;

/**
 * Suppressions below this are not worth mentioning even on the next emission.
 * One dropped duplicate is not information.
 */
const MIN_REPORTED_SUPPRESSIONS = 2;

export type Level = 'info' | 'warn' | 'error';

interface LogState {
  tick: number;
  linesThisTick: number;
  /** signature -> last tick it was emitted. */
  lastSeen: Record<string, number>;
  /** signature -> how many times it was suppressed since that emission. */
  dropped: Record<string, number>;
}

function logState(): LogState {
  const s = heapGet<LogState>('log', () => ({
    tick: Game.time,
    linesThisTick: 0,
    lastSeen: {},
    dropped: {},
  }));

  if (s.tick !== Game.time) {
    s.tick = Game.time;
    s.linesThisTick = 0;
    prune(s);
  }
  return s;
}

/** Drop signatures that can no longer suppress anything. */
function prune(s: LogState): void {
  for (const [signature, tick] of Object.entries(s.lastSeen)) {
    if (Game.time - tick < SIGNATURE_MEMORY) continue;
    delete s.lastSeen[signature];
    delete s.dropped[signature];
  }
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

  const withinInterval = last !== undefined && Game.time - last < SIGNATURE_INTERVAL;
  const budgetSpent = s.linesThisTick >= TICK_LINE_BUDGET;

  if (withinInterval || budgetSpent) {
    s.dropped[signature] = (s.dropped[signature] ?? 0) + 1;
    return;
  }

  // The count of what this signature lost since its last emission rides along
  // with the emission itself — bounded output, no separate summary line.
  const dropped = s.dropped[signature] ?? 0;
  const suffix = dropped >= MIN_REPORTED_SUPPRESSIONS ? ` (+${String(dropped)} suppressed)` : '';
  delete s.dropped[signature];

  s.lastSeen[signature] = Game.time;
  s.linesThisTick += 1;

  const prefix = level === 'info' ? '' : `[${level}] `;
  console.log(`[${Game.time}] ${prefix}${message}${suffix}`);
}
