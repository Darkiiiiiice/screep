/**
 * Task planning: turn a room snapshot into tasks on the board.
 *
 * The planner is the AUTHORITY on what work exists. Each tick it rebuilds the
 * room's task set from the snapshot and PRUNES anything it did not produce.
 *
 * That pruning is what makes the board genuinely derived rather than a
 * collection that only ever grows. Without it, work that stopped being useful
 * but whose target still exists — a drained source, a finished construction
 * site, a filled container — stays on the board and keeps being offered to
 * creeps that then find nothing to do. Deriving the whole set sidesteps that
 * class of bug instead of defending against it, and it removes any need to track
 * per-task progress: a task exists exactly while its work does.
 *
 * Pruning is scoped to this room. With several rooms, a room-local "not
 * re-created" set must not delete a neighbouring room's work.
 */
import type { ColonyState, RoomView } from './types';
import { addTask, type TaskBoard } from './tasks';

export interface PlanResult {
  created: number;
  /** Tasks removed because their work is no longer wanted. */
  pruned: number;
}

/**
 * Rebuild a room's tasks from its current state.
 *
 * Refuses to plan anything for a room we do not own. Callers filter with
 * `ownedRooms()`, but the check belongs here too: it is the invariant that stops
 * the colony from spending creeps on someone else's room if a controller is lost
 * mid-game, and an invariant enforced in one place survives a new caller.
 */
export function planTasks(
  board: TaskBoard,
  room: RoomView,
  state: ColonyState,
  now: number,
): PlanResult {
  if (room.controller?.my !== true) return { created: 0, pruned: 0 };

  const before = board.nextId;

  // Keys the planner produced this tick. Anything in this room not in here has
  // stopped being work and is pruned below.
  const wanted: Record<string, true> = {};
  const want = (key: string): void => {
    wanted[key] = true;
  };

  // Harvesting is the base of every economy tier. A source with energy left is
  // always worth someone's time; a drained one is not.
  for (const source of room.sources) {
    if (source.energy <= 0) continue;
    const task = addTask(
      board,
      {
        kind: 'harvest',
        targetId: source.id,
        room: room.name,
        role: 'harvester',
      },
      now,
    );
    want(task.key);
  }

  // Upgrading keeps the controller alive and is the only path to the next RCL.
  //
  // Planned unconditionally. An earlier version skipped this under threat as a
  // way of "not feeding a doomed controller", which was inert: `decideUpgrader`
  // never reads its task, so the task was pruned every tick while the creep
  // upgraded anyway. The threat response now lives in `decideUpgrader`, the one
  // place it can take effect. See domain/roles.ts.
  const controller = room.controller;
  const task = addTask(
    board,
    {
      kind: 'upgrade',
      targetId: controller.id,
      room: room.name,
      role: 'upgrader',
      // Priority scales with urgency: as the downgrade timer runs down this
      // must outrank routine work rather than wait its turn.
      priority: controller.ticksToDowngrade < 5000 ? 10 : 0,
    },
    now,
  );
  want(task.key);

  // One site per task, so several builders work in parallel instead of queueing
  // behind a single "build something" job.
  for (const site of room.constructionSites) {
    const task = addTask(
      board,
      { kind: 'build', targetId: site.id, room: room.name, role: 'builder' },
      now,
    );
    want(task.key);
  }

  // Deliveries only make sense once there is somewhere to buffer. Below that,
  // harvesters carry energy themselves and the sink is the spawn.
  if (state !== 'BOOTSTRAP') {
    for (const store of room.stores) {
      if (store.energyCapacity === undefined || store.energy >= store.energyCapacity) continue;
      const task = addTask(
        board,
        { kind: 'deliver', targetId: store.id, room: room.name, role: 'hauler' },
        now,
      );
      want(task.key);
    }
  }

  const pruned = pruneUnwanted(board, room.name, wanted);

  return { created: board.nextId - before, pruned };
}

/**
 * Drop this room's tasks that the planner did not produce this tick.
 *
 * Deliberately scoped by room: the `wanted` set describes one room, so pruning
 * globally would delete every other room's work.
 */
function pruneUnwanted(board: TaskBoard, roomName: string, wanted: Record<string, true>): number {
  let pruned = 0;

  for (const task of Object.values(board.tasks)) {
    if (task.room !== roomName) continue;
    if (wanted[task.key] === true) continue;
    delete board.tasks[task.id];
    pruned += 1;
  }

  return pruned;
}
