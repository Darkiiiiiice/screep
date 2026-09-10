/**
 * Error isolation and reporting.
 *
 * The engine runs one script per player per tick. An exception that escapes
 * `loop()` aborts the remainder of that player's tick — so an unhandled error
 * in one creep's logic silently costs every other creep its orders. Everything
 * that calls into game logic must therefore run inside `guard`.
 *
 * Reporting is deliberately stingy. An AI in a bad state fails every tick, and
 * a stack trace per tick would consume the CPU budget that the fix needs. So:
 *   - errors are deduped by signature (error name + site), and
 *   - the most recent few are kept in Memory for post-mortem via `stats`.
 */

import { log } from './log';

/** Recent errors retained in Memory for post-mortem inspection. */
const RING_SIZE = 20;

interface RecordedError {
  tick: number;
  signature: string;
  message: string;
  /** First line of the stack, which names the throw site. */
  site: string;
}

interface ErrorState {
  ring: RecordedError[];
  /** signature -> count, to show whether a failure is chronic or transient. */
  counts: Record<string, number>;
}

interface MemoryWithErrors {
  errors?: ErrorState;
}

/**
 * Derive a stable signature for an error.
 *
 * Deliberately excludes the message body where it contains variable data: two
 * failures of the same operation with different ids are the same bug, and
 * treating them as distinct would defeat the deduplication.
 */
function signatureOf(err: unknown): { signature: string; message: string; site: string } {
  if (!(err instanceof Error)) {
    return {
      signature: `non-error:${String(err).slice(0, 40)}`,
      message: String(err),
      site: 'unknown',
    };
  }

  // Second stack line is the first frame inside our code (the first carries the
  // message). V8 formats it either as `at fn (file:line:col)` or `at file:line:col`.
  const frame = (err.stack ?? '').split('\n')[1]?.trim() ?? '';
  const site =
    frame
      .replace(/^at\s+/, '')
      .replace(/\(.*\)$/, '') // drop "(file:line:col)"
      .replace(/:\d+:\d+$/, '') // drop a trailing ":line:col"
      .trim() || 'unknown';

  return { signature: `${err.name}@${site}`, message: err.message, site };
}

/**
 * Run `fn`, containing any throw.
 *
 * @returns the result, or undefined if it threw
 */
export function guard<T>(fn: () => T, what: string): T | undefined {
  try {
    return fn();
  } catch (err) {
    record(err, what);
    return undefined;
  }
}

/** Record an error: aggregate the count, retain detail, report via the log. */
export function record(err: unknown, what: string): void {
  const { signature, message, site } = signatureOf(err);
  const state = errorState();

  state.counts[signature] = (state.counts[signature] ?? 0) + 1;

  // Bounded ring for post-mortem. Every occurrence is kept here even when the
  // console line is throttled away — the ring is the complete record, the
  // console is the summary.
  state.ring.push({ tick: Game.time, signature, message, site });
  if (state.ring.length > RING_SIZE) state.ring.shift();

  // Console throttling is `log`'s job, keyed on the same signature, so repeated
  // failures collapse to one line per interval without a second mechanism here.
  log('error', signature, `${what} failed: ${message}`);
}

/**
 * Error state, held in Memory.
 *
 * This is one of the few things that legitimately belongs in Memory: after a
 * crash the heap is gone, and the whole point is to inspect what happened
 * before the restart.
 */
function errorState(): ErrorState {
  const mem = Memory as unknown as MemoryWithErrors;
  mem.errors ??= { ring: [], counts: {} };
  return mem.errors;
}

/** Recent errors, newest last. Read by the stats segment. */
export function recentErrors(): RecordedError[] {
  return errorState().ring.slice();
}

/**
 * Cumulative failure count per signature.
 *
 * Distinguishes chronic from transient: one occurrence is an incident, five
 * hundred means something is structurally broken and needs a fix rather than a
 * retry. Surfaced through the stats segment.
 */
export function errorCounts(): Record<string, number> {
  return { ...errorState().counts };
}

/** Drop retained errors, e.g. after reviewing them. */
export function clearErrors(): void {
  const mem = Memory as unknown as MemoryWithErrors;
  mem.errors = { ring: [], counts: {} };
}
