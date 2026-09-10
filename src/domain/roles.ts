/**
 * Role behaviour: given a creep, its task, and the room, decide its intent.
 *
 * Two things are deliberate here:
 *
 *   1. Range is computed as pure arithmetic. Screeps movement is 8-directional,
 *      so distance is Chebyshev (max of |dx|, |dy|), and each action has a fixed
 *      reach. Knowing this in the domain lets it emit "move" instead of "act"
 *      when out of reach, which saves a tick per approach — at 20 ms CPU and one
 *      action per tick, that is the difference between an economy that grows and
 *      one that idles.
 *
 *   2. Energy acquisition is a decision, not an assumption. Every role that
 *      spends energy must answer "where does it come from" first, and the answer
 *      differs by tier: at BOOTSTRAP a harvester feeds itself and the spawn is
 *      the only sink; once containers exist a hauler does the walking.
 *
 * Every position used here comes from the snapshot. Fabricating a coordinate
 * (e.g. giving the controller `0,0`) would issue real move orders to the corner
 * of the room, so a missing position is treated as "cannot act on this" rather
 * than guessed.
 */
import type { CreepView, Intent, RoomView, SourceView, StoreView } from './types';
import type { Task } from './tasks';

/** Reach of each action, in tiles (Chebyshev). */
const REACH: Record<string, number> = {
  harvest: 1,
  transfer: 1,
  withdraw: 1,
  pickup: 1,
  build: 3,
  repair: 3,
  upgrade: 3,
};

/** Chebyshev distance — the number of ticks to close on a target. */
export function rangeBetween(a: Coords, b: Coords): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Anything the domain can measure distance to. */
interface Coords {
  x: number;
  y: number;
}

/** A candidate target, which must also be nameable in an intent. */
interface Positioned extends Coords {
  id: string;
}

/**
 * Emit an action, or a move when the target is out of reach.
 *
 * The adapter still has to cope with ERR_NOT_IN_RANGE (the target may move), but
 * deciding here saves the wasted tick in the common case.
 */
function actOrApproach(
  creep: CreepView,
  target: Positioned,
  kind: 'harvest' | 'transfer' | 'withdraw' | 'pickup' | 'build' | 'repair' | 'upgrade',
  amount?: number,
): Intent {
  if (rangeBetween(creep, target) > (REACH[kind] ?? 1)) {
    return { kind: 'moveTo', creep: creep.name, x: target.x, y: target.y, room: creep.room };
  }

  switch (kind) {
    case 'transfer':
      return { kind, creep: creep.name, targetId: target.id, amount };
    case 'withdraw':
      return { kind, creep: creep.name, targetId: target.id, amount };
    case 'harvest':
    case 'pickup':
    case 'build':
    case 'repair':
    case 'upgrade':
      return { kind, creep: creep.name, targetId: target.id };
  }
}

/** Nearest object by Chebyshev distance; ties broken by id for determinism. */
function nearest<T extends Positioned>(from: Coords, candidates: T[]): T | null {
  let best: T | null = null;
  let bestRange = Infinity;

  for (const candidate of candidates) {
    const range = rangeBetween(from, candidate);
    if (range < bestRange || (range === bestRange && best !== null && candidate.id < best.id)) {
      best = candidate;
      bestRange = range;
    }
  }
  return best;
}

/** Stores with room for more energy. */
function sinksFor(room: RoomView): StoreView[] {
  return room.stores.filter((s) => s.energyCapacity !== undefined && s.energy < s.energyCapacity);
}

/** Stores currently holding energy to take. */
function energySources(room: RoomView): StoreView[] {
  return room.stores.filter((s) => s.energy > 0);
}

/** Sources with energy available right now. */
function harvestable(room: RoomView): SourceView[] {
  return room.sources.filter((s) => s.energy > 0);
}

/** Same as `energySources`, minus the spawn, whose stock is reserved. */
function buffers(room: RoomView): StoreView[] {
  return energySources(room).filter((s) => s.type !== 'spawn');
}

/** Which sink to fill when several want energy: the nearest. */
function bestSink(creep: CreepView, room: RoomView): StoreView | null {
  return nearest(creep, sinksFor(room));
}

/**
 * Decide the intent for a creep, or null when it has nothing useful to do.
 *
 * The task may be null: a creep that leased nothing still needs an energy
 * decision, since standing idle gains nothing.
 */
export function decide(creep: CreepView, task: Task | null, room: RoomView): Intent | null {
  switch (creep.role) {
    case 'harvester':
      return decideHarvester(creep, task, room);
    case 'hauler':
      return decideHauler(creep, room);
    case 'upgrader':
      return decideUpgrader(creep, room);
    case 'builder':
      return decideBuilder(creep, task, room);
    default:
      return null;
  }
}

/**
 * Harvester: mines its own energy and deposits it.
 *
 * The rule that matters here is FILL BEFORE TRAVEL. An earlier version delivered
 * as soon as it held any energy, and the measured effect was severe: the creep
 * harvested one tick (4 energy with 2 WORK parts), walked five tiles to the
 * spawn, delivered 4, and walked back — roughly ten tiles of travel per 4 energy,
 * which is why the room sat at zero controller progress.
 *
 * Carrying capacity is 50, so filling first multiplies throughput by an order of
 * magnitude for the same walking. The exception is a source with nothing left to
 * give: then delivering a partial load beats standing still until it regrows.
 */
function decideHarvester(creep: CreepView, task: Task | null, room: RoomView): Intent | null {
  const full = creep.energy >= creep.carryCapacity;

  if (!full) {
    const assigned =
      task?.kind === 'harvest' ? room.sources.find((s) => s.id === task.targetId) : null;
    const source = assigned?.energy ? assigned : nearest(creep, harvestable(room));

    if (source) return actOrApproach(creep, source, 'harvest');

    // Nothing left to mine. Deliver what is held rather than idle until the
    // source regenerates.
    if (creep.energy === 0) return null;
  }

  const sink = bestSink(creep, room);
  if (sink) return actOrApproach(creep, sink, 'transfer');

  // Nothing wants energy: put it into the controller rather than idle with a
  // full carry. Strictly better than holding it.
  const controller = room.controller;
  if (controller?.my) return actOrApproach(creep, controller, 'upgrade');
  return null;
}

/**
 * Hauler: moves buffered energy to a consumer.
 *
 * Only exists once containers do; below that it would compete with the
 * harvesters for the same pool of energy.
 */
function decideHauler(creep: CreepView, room: RoomView): Intent | null {
  if (creep.energy >= creep.carryCapacity) {
    const sink = bestSink(creep, room);
    return sink ? actOrApproach(creep, sink, 'transfer') : null;
  }

  // Top up before travelling, unless nothing can fill it — then deliver what it
  // has rather than stand still.
  const supply = nearest(creep, energySources(room));
  if (supply) return actOrApproach(creep, supply, 'withdraw');

  const sink = bestSink(creep, room);
  return sink ? actOrApproach(creep, sink, 'transfer') : null;
}

/**
 * Upgrader: converts energy into controller progress.
 *
 * Same fill-before-travel rule as the harvester, and it matters more here: the
 * controller is far from the sources, so a creep that upgrades 2 energy per
 * round trip spends nearly all its time walking. It fills its carry first, then
 * upgrades until empty.
 *
 * It feeds itself from buffers or a source rather than draining the spawn, whose
 * energy is what replaces dead creeps. Trading survival for progress is a bad
 * trade at every level.
 */
function decideUpgrader(creep: CreepView, room: RoomView): Intent | null {
  const controller = room.controller;
  if (!controller?.my) return null;

  const full = creep.energy >= creep.carryCapacity;

  if (!full) {
    const buffer = nearest(creep, buffers(room));
    if (buffer) return actOrApproach(creep, buffer, 'withdraw');

    const source = nearest(creep, harvestable(room));
    if (source) return actOrApproach(creep, source, 'harvest');

    // Nothing to draw from: spend what is held rather than idle.
    if (creep.energy === 0) return null;
  }

  return actOrApproach(creep, controller, 'upgrade');
}

/** Builder: fetches energy, then applies it to a construction site. */
function decideBuilder(creep: CreepView, task: Task | null, room: RoomView): Intent | null {
  const full = creep.energy >= creep.carryCapacity;

  if (!full) {
    const buffer = nearest(creep, buffers(room));
    if (buffer) return actOrApproach(creep, buffer, 'withdraw');

    const source = nearest(creep, harvestable(room));
    if (source) return actOrApproach(creep, source, 'harvest');

    if (creep.energy === 0) return null;
  }

  const assigned =
    task?.kind === 'build' ? room.constructionSites.find((s) => s.id === task.targetId) : undefined;
  const site = assigned ?? nearest(creep, room.constructionSites);
  if (!site) return null;
  return actOrApproach(creep, site, 'build');
}

