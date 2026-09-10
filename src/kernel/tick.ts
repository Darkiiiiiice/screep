/**
 * Tick kernel.
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
 * Phase bodies land in M2+. What is fixed here is the ordering, the budget
 * arithmetic, the failure isolation, and the per-phase profiling.
 */
import { ownedRooms, viewRoom } from '../game/view';
import { tickRoom } from '../colony/room';
import { guard, record } from './errors';
import { log } from './log';
import { initMemory, gcDeadCreeps } from './memory';
import { maybeReportProfile, profilePhase } from './profiler';
import { maybeWriteStats } from './stats';

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
  profilePhase('kernel:init', initMemory);

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
      profilePhase(phase, () => runPhase(phase));
    } catch (err) {
      record(err, `phase ${phase}`);
    }
  }

  if (skipped.length > 0) {
    log(
      'warn',
      'degrade',
      `cpu=${Game.cpu.getUsed().toFixed(1)}/${working.toFixed(1)} skipped=${skipped.join(',')}`,
    );
  }

  profilePhase('kernel:report', maybeReportProfile);
}

/**
 * Phase bodies. Kept as an explicit switch so the pipeline order is visible in
 * one place and adding a phase is a compile error until it is handled.
 */
function runPhase(phase: Phase): void {
  switch (phase) {
    case 'execute':
      tickColony();
      return;

    case 'cleanup':
      // Memory first: reclaiming dead creeps' entries shrinks what the stats
      // write has to serialize, and both happen in this phase.
      gcDeadCreeps();
      maybeWriteStats();
      return;

    // These phases exist in the pipeline but have no work yet:
    //   prefetch — per-tick Game snapshot, once the view is cached rather than
    //              rebuilt per consumer.
    //   intel    — neighbouring-room scouting (M4).
    //   plan/spawn/assign — currently inside `tickColony`, which runs them in
    //              the required order. Splitting them out is M2 follow-up work;
    //              keeping them here would mean two places deciding the order.
    case 'prefetch':
    case 'intel':
    case 'plan':
    case 'spawn':
    case 'assign':
      return;
  }
}

/**
 * Run every owned room for this tick.
 *
 * Rooms are processed in name order so behaviour is reproducible: two rooms
 * competing for the same spawn queue or the same recorded snapshot must resolve
 * the same way every run.
 */
function tickColony(): void {
  const rooms = ownedRooms();
  if (rooms.length === 0) return;

  // Built once per tick and shared: a creep standing in room A is part of room
  // B's population only if it is actually there, so each view filters the same
  // list rather than each room re-walking `Game.creeps`.
  const creeps = Object.values(Game.creeps);

  for (const room of rooms.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const result = guard(() => tickRoom(viewRoom(room, creeps), room), `room ${room.name}`);
    if (!result) continue;

    // The room name is in the message, not just the throttle signature: with
    // several rooms this line is otherwise unattributable in the console.
    //
    // `creeps` and `spawn` together answer "is the economy alive" at a glance,
    // which is the question this line exists to answer. CPU budget alone cannot
    // distinguish a working colony from an idle one.
    log(
      'info',
      `room:${room.name}`,
      `${room.name} ${result.state} creeps=${String(result.population)} placed=${String(result.placed)} intents=${String(result.tally.attempted)} ok=${String(result.tally.succeeded)} deferred=${String(result.tally.deferred)} noRoute=${String(result.tally.noRoute)} reaped=${String(result.reaped)} pruned=${String(result.pruned)} spawn=${result.spawnReason}`,
    );
  }
}
