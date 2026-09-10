/**
 * Task planning: turn a room snapshot into tasks on the board.
 *
 * Runs every tick, so every task it creates MUST be idempotent — `addTask` keys
 * on the work itself, which is what keeps the board from growing a duplicate per
 * tick. Planning is separated from behaviour on purpose: what work exists is a
 * property of the room, while who does it and how depends on the creeps.
 */
import type { ColonyState, RoomView } from './types';
import { addTask, type TaskBoard } from './tasks';

/**
 * Create the tasks a room's current state implies.
 *
 * Refuses to plan anything for a room we do not own. Callers currently filter
 * with `ownedRooms()`, but the ownership check belongs here too: it is the
 * invariant that stops the colony from spending its creeps on someone else's
 * room if a controller is lost mid-game, and an invariant enforced in one place
 * is one that survives a new caller.
 *
 * @returns how many tasks were created (0 when everything already existed)
 */
export function planTasks(board: TaskBoard, room: RoomView, state: ColonyState, now: number): number {
  if (room.controller?.my !== true) return 0;

  const before = board.nextId;

  // Harvesting is the base of every economy tier: a source with energy left is
  // always work worth someone's time.
  for (const source of room.sources) {
    if (source.energy <= 0) continue;
    addTask(
      board,
      {
        kind: 'harvest',
        targetId: source.id,
        room: room.name,
        role: 'harvester',
        remaining: source.energy,
      },
      now,
    );
  }

  // Upgrading keeps the controller alive and is the only path to the next RCL.
  // Skipped under threat: a controller that downgrades is recoverable, a colony
  // that runs out of creeps is not, and at 20 ms CPU the difference matters.
  // Ownership is already established by the guard above.
  const controller = room.controller;
  if (room.hostiles.length === 0) {
    addTask(
      board,
      {
        kind: 'upgrade',
        targetId: controller.id,
        room: room.name,
        role: 'upgrader',
        // Priority scales with urgency: as the downgrade timer runs down, this
        // must outrank routine work rather than wait its turn.
        priority: controller.ticksToDowngrade < 5000 ? 10 : 0,
      },
      now,
    );
  }

  // One site per task, so several builders can work in parallel instead of
  // queueing behind a single "build something" job.
  for (const site of room.constructionSites) {
    addTask(
      board,
      {
        kind: 'build',
        targetId: site.id,
        room: room.name,
        role: 'builder',
        remaining: site.progressTotal - site.progress,
      },
      now,
    );
  }

  // Deliveries only make sense once there is somewhere to buffer. Below that,
  // harvesters carry energy themselves and the target is the spawn.
  if (state !== 'BOOTSTRAP') {
    for (const store of room.stores) {
      if (store.energyCapacity === undefined || store.energy >= store.energyCapacity) continue;
      addTask(
        board,
        {
          kind: 'deliver',
          targetId: store.id,
          room: room.name,
          role: 'hauler',
          remaining: store.energyCapacity - store.energy,
        },
        now,
      );
    }
  }

  return board.nextId - before;
}
