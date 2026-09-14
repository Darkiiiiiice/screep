/**
 * Screeps tick entrypoint.
 *
 * The server calls `loop()` once per tick. Everything above this file is
 * ordinary TypeScript; this file is the only place that establishes the
 * process-wide state the engine resets between ticks.
 *
 * Contract notes that shape this file:
 *   - `global` survives between ticks but is cleared whenever the engine
 *     restarts the runtime, so nothing here may be the sole home of state that
 *     cannot be rebuilt from `Game` / `Memory`.
 *   - An exception that escapes `loop()` aborts the rest of the tick for every
 *     creep we own, so the body must be wrapped and failures contained.
 *
 * M1 delegates engine access to the adapter and pure population decisions to
 * domain/bootstrap. Existing units are adopted without requiring role flags.
 */
import { runBootstrap } from './game/bootstrap';

export function loop(): void {
  try { runBootstrap(); } catch (error) {
    console.log(`[M1] entry: ${error instanceof Error ? error.message : String(error)}`);
  }
}
