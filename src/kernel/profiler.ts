/**
 * Per-phase CPU profiling with rolling averages.
 *
 * The problem this solves: with a 20 ms budget, "which phase got expensive" is
 * the first question after any slowdown, and a single tick's numbers are noise
 * (a GC tick, a first-touch of a cached CostMatrix). So we keep a rolling mean
 * per phase, reported on an interval.
 *
 * Cost discipline: reading `Game.cpu.getUsed()` twice per phase is cheap, but
 * formatting and logging a report every tick is not. The report interval grows
 * as the sample count grows, so a stable system logs rarely and a changing one
 * logs often — the opposite would waste budget precisely when it is scarce.
 */
import { heapGet } from './heap';
import { log } from './log';

interface PhaseStat {
  /** Rolling mean of CPU spent in this phase, in ms. */
  mean: number;
  /** Samples collected since the last report. */
  samples: number;
  /** Peak observed since the last report. */
  peak: number;
}

interface ProfilerState {
  phases: Record<string, PhaseStat>;
  /** Ticks since the last report was emitted. */
  sinceReport: number;
  /** Current report interval in ticks; grows with stability. */
  interval: number;
}

const INITIAL_INTERVAL = 100;

/**
 * Profiler state lives in the heap, like all other cross-tick kernel scratch
 * data. Losing it on a runtime restart only costs one report interval.
 */
function profilerState(): ProfilerState {
  return heapGet<ProfilerState>('profiler', () => ({
    phases: {},
    sinceReport: 0,
    interval: INITIAL_INTERVAL,
  }));
}

/**
 * Time a phase.
 *
 * Uses an explicit `Game.cpu.getUsed()` bracket rather than wall-clock: the
 * number that matters is what the engine charges us, and that is what getUsed
 * reports.
 */
export function profilePhase<T>(phase: string, fn: () => T): T {
  const started = Game.cpu.getUsed();
  try {
    return fn();
  } finally {
    recordSample(phase, Game.cpu.getUsed() - started);
  }
}

/** Fold one measurement into the rolling mean for a phase. */
function recordSample(phase: string, spent: number): void {
  const s = profilerState();
  const stat = (s.phases[phase] ??= { mean: 0, samples: 0, peak: 0 });

  // Incremental mean: avoids retaining a sample array we would have to bound.
  stat.samples += 1;
  stat.mean += (spent - stat.mean) / stat.samples;
  if (spent > stat.peak) stat.peak = spent;
}

/** Record a non-phase measurement under its own key (e.g. cleanup work). */
export function profileValue(key: string, spent: number): void {
  recordSample(key, spent);
}

/**
 * Emit a report when the interval has elapsed.
 *
 * Returns true when a report was written, so the caller can surface the same
 * data into the stats segment.
 */
export function maybeReportProfile(): boolean {
  const s = profilerState();
  s.sinceReport += 1;
  if (s.sinceReport < s.interval) return false;

  const entries = Object.entries(s.phases);
  if (entries.length === 0) return false;

  // Sort by mean descending: the expensive phase is the one worth seeing.
  const ranked = entries.sort((a, b) => b[1].mean - a[1].mean);
  const summary = ranked
    .map(([phase, stat]) => `${phase}=${stat.mean.toFixed(2)}/${stat.peak.toFixed(1)}`)
    .join(' ');

  log('info', 'profiler', `cpu/phase mean/peak: ${summary}`);

  // Reset peaks, keep means: a transient spike should not dominate the next
  // report, but the long-run mean is the number we tune against.
  for (const [, stat] of entries) stat.peak = 0;
  s.sinceReport = 0;
  return true;
}

/** Snapshot of mean CPU per phase, for the stats segment. */
export function profileSnapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [phase, stat] of Object.entries(profilerState().phases)) {
    out[phase] = Number(stat.mean.toFixed(3));
  }
  return out;
}
