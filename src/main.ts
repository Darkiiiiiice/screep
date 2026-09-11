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
 * The previous implementation (kernel / domain / game / colony layers) was
 * removed on 2026-09-11 pending a redesign; this is the bare entrypoint the
 * build pipeline and `npm run smoke` need in order to stay exercisable.
 */
export function loop(): void {
  // Intentionally empty until the redesign lands.
}
