/**
 * Tick kernel skeleton.
 *
 * Phase pipeline with CPU accounting and priority-based degradation. The CPU
 * budget is a real constraint, not a nicety: the official server hard-stops the
 * script at `Game.cpu.limit` (20 ms until CPU Unlock raises it), so a tick that
 * overruns loses the tail of its work — and an unfinished spawn or assignment
 * costs more than a missed scan.
 *
 * Phase order and why:
 *   prefetch -> intel -> plan -> spawn -> assign -> execute -> cleanup
 *
 *   spawn before assign: a creep born this tick can still be given work this
 *     tick, which shortens the gap after a death.
 *   cleanup last, and always runs: memory GC and the stats write are what make
 *     the *next* tick possible.
 *
 * Full phase bodies land in M1/M2. What is fixed here is the ordering, the
 * budget arithmetic, and the failure isolation.
 */

/** Work phases, in pipeline order. */
export const PHASES = [
  'prefetch',
  'intel',
  'plan',
  'spawn',
  'assign',
  'execute',
  'cleanup',
] as const;

export type Phase = (typeof PHASES)[number];

/**
 * Phases that must run regardless of CPU pressure. `cleanup` is included
 * because skipping memory GC or the stats write corrupts the next tick, which
 * is worse than running this one over budget.
 */
const NEVER_SKIP: Partial<Record<Phase, true>> = {
  spawn: true,
  assign: true,
  cleanup: true,
};

/** Fraction of the working budget held back so cleanup always fits. */
const CLEANUP_RESERVE = 0.12;

/**
 * Start skipping low-priority phases once we pass this fraction of the working
 * budget. Deliberately below 1.0 so we degrade *before* the engine cuts us off.
 */
const DEGRADE_THRESHOLD = 0.8;

/**
 * CPU budget for this tick.
 *
 * `Game.cpu.tickLimit` already accounts for bucket accumulation (a filled
 * bucket lets a single tick borrow up to 500 CPU), so it is the real ceiling.
 * Taking the smaller of tickLimit and the account baseline keeps a bucket burst
 * from turning one tick into a long stall for every other player.
 */
export function tickBudget(): number {
  return Math.min(Game.cpu.tickLimit, Game.cpu.limit);
}

/**
 * Run one tick.
 *
 * Each phase is isolated: a throwing phase is reported and the pipeline
 * continues, because losing one phase is strictly better than losing the tick.
 */
export function kernelTick(): void {
  // Hold back the cleanup reserve up front so degradation decisions are made
  // against the budget we can actually spend.
  const working = tickBudget() * (1 - CLEANUP_RESERVE);
  const skipped: Phase[] = [];

  for (const phase of PHASES) {
    const overBudget = Game.cpu.getUsed() > working * DEGRADE_THRESHOLD;
    if (overBudget && !NEVER_SKIP[phase]) {
      skipped.push(phase);
      continue;
    }

    try {
      runPhase(phase);
    } catch (err) {
      reportFailure(`phase ${phase}`, err);
    }
  }

  if (skipped.length > 0) {
    log(`tick=${Game.time} cpu=${Game.cpu.getUsed().toFixed(1)}/${working.toFixed(1)} skipped=${skipped.join(',')}`);
  }
}

/**
 * Phase implementations land in M1/M2. Kept as an explicit switch so the
 * pipeline order is visible in one place and adding a phase is a compile error
 * until it is handled.
 */
function runPhase(phase: Phase): void {
  switch (phase) {
    case 'prefetch':
    case 'intel':
    case 'plan':
    case 'spawn':
    case 'assign':
    case 'execute':
    case 'cleanup':
      return;
  }
}

// TODO(M1): move into src/kernel/errors.ts and src/kernel/log.ts —
// signature-based dedupe, a ring buffer in Memory, and a console budget. Until
// then, rate-limit so a broken phase cannot flood the console and burn CPU on
// logging every tick.
let lastReportTick = -Infinity;
const REPORT_INTERVAL = 20;

function shouldReport(): boolean {
  if (Game.time - lastReportTick < REPORT_INTERVAL) return false;
  lastReportTick = Game.time;
  return true;
}

function log(message: string): void {
  console.log(`[kernel] ${message}`);
}

function reportFailure(what: string, err: unknown): void {
  if (!shouldReport()) return;
  const detail = err instanceof Error ? err.message : String(err);
  log(`tick=${Game.time} ${what} failed: ${detail}`);
}
