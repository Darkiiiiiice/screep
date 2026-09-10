/**
 * Per-room orchestration.
 *
 * The seam where the pure domain meets the engine. Its job is sequencing and
 * persistence, not decision-making: every "what should happen" question is
 * answered by `src/domain/**`, and every "how does that reach the engine"
 * question by `src/game/**`. What lives here is the order those calls happen in
 * and what survives between ticks.
 *
 * Order matters and is the whole reason this is one function:
 *
 *   reap -> drop invalid -> plan -> assign -> decide -> execute
 *
 *   reap FIRST: a lease held by a creep that died last tick must be returned
 *     before planning, or the work it held is invisible to the reassignment
 *     pass and the colony stalls with idle creeps and stranded tasks.
 *   plan before assign: tasks must exist before anything can take them.
 *   assign before decide: a creep's intent depends on the task it holds.
 */
import type { Intent, Role, RoomView } from '../domain/types';
import { deriveState } from '../domain/state';
import { roleDemand, shortfall } from '../domain/demand';
import {
  dropTasksForMissingTargets,
  emptyBoard,
  leaseTask,
  reapExpired,
  type TaskBoard,
} from '../domain/tasks';
import { planTasks } from '../domain/plan';
import { decide } from '../domain/roles';
import { planSpawns, populationByRole } from './spawn';
import { executeAll, type ExecutionTally } from '../game/execute';
import { heapGet } from '../kernel/heap';
import { guard } from '../kernel/errors';

/**
 * The task board.
 *
 * Held in the heap, not in Memory. The board is rebuilt from the room every tick
 * by `planTasks`, so its durability is worth nothing — and keeping it out of
 * Memory avoids a per-tick `JSON.stringify` of a structure that scales with the
 * number of tasks. The lease *deadlines* it carries are the only thing that
 * would be lost, and losing them costs one tick of reassignment.
 */
function board(): TaskBoard {
  return heapGet<TaskBoard>('taskBoard', emptyBoard);
}

export interface RoomTickResult {
  room: string;
  state: string;
  tally: ExecutionTally;
  /** Roles below their demand, for the stats segment. */
  shortfall: { role: string; missing: number }[];
  /** Leases reclaimed because their holder died or timed out. */
  reaped: number;
  /** Tasks dropped because their target no longer exists. */
  dropped: number;
  /** Why nothing spawned, when nothing did. */
  spawnReason: string;
}

/** Run one room for one tick. */
export function tickRoom(view: RoomView): RoomTickResult {
  const now = Game.time;
  const b = board();

  // 1. Recover work whose holder is gone. This is the step that keeps a single
  //    creep death from permanently removing work from the pool.
  const living: Partial<Record<string, true>> = {};
  for (const creep of view.creeps) living[creep.name] = true;
  const reaped = reapExpired(b, now, living);

  // 2. Drop work whose target is gone — a destroyed site, an emptied source.
  const validTargets: Partial<Record<string, true>> = {};
  for (const s of view.sources) validTargets[s.id] = true;
  for (const s of view.stores) validTargets[s.id] = true;
  for (const s of view.constructionSites) validTargets[s.id] = true;
  if (view.controller) validTargets[view.controller.id] = true;
  const dropped = dropTasksForMissingTargets(b, validTargets);

  // 3. Create this tick's work.
  const state = deriveState(view).state;
  planTasks(b, view, state, now);

  const intents: Intent[] = [];

  // 4. Spawn before assigning: a creep born this tick can receive work this
  //    tick, which shortens the gap after a death by a full spawn duration.
  const spawning = planSpawns(view, state);
  intents.push(...spawning.intents);

  // 5. Assign and decide. Leasing is guarded because a lease failure must not
  //    cost a creep its tick — it can still be given an energy decision.
  for (const creep of view.creeps) {
    const task = guard(
      () => leaseTask(b, creep.name, { roles: TASK_ROLES[creep.role] ?? [] }, now),
      `lease ${creep.name}`,
    );
    const intent = decide(creep, task ?? null, view);
    if (intent) intents.push(intent);
  }

  // 6. Execute.
  const tally = executeAll(intents);

  return {
    room: view.name,
    state,
    tally,
    shortfall: shortfall(roleDemand(view, state), populationByRole(view)).map((s) => ({
      role: s.role,
      missing: s.missing,
    })),
    reaped,
    dropped,
    spawnReason: spawning.reason,
  };
}

/**
 * Which task kinds a role may take.
 *
 * Explicit rather than derived from the role name, because the mapping is not
 * one-to-one: a harvester legitimately takes harvest tasks, while a defender
 * takes none at all (its work is reactive, not planned).
 */
const TASK_ROLES: Record<string, Role[]> = {
  harvester: ['harvester'],
  hauler: ['hauler'],
  upgrader: ['upgrader'],
  builder: ['builder'],
  defender: [],
};

export { board };
