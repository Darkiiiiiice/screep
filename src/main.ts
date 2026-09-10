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
 *     creep we own, so the body is wrapped and failures are contained.
 */
import { kernelTick } from '@/kernel/tick';

export function loop(): void {
  kernelTick();
}
