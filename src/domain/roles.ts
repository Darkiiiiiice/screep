/**
 * Role behaviour: given a creep, its task, and the room, decide its intent.
 *
 * The governing rule is ACT LOCALLY. A creep should take the action available to
 * it right now, and travel only when no action is available. Every earlier
 * version of this file got that wrong in a different way, and both mistakes were
 * caught live rather than in tests:
 *
 *   1. "Deliver as soon as any energy is held" made a harvester walk 5 tiles to
 *      bank 4 energy — one tick of mining per two of travel.
 *   2. The over-correction, "deliver only when completely full", made an
 *      upgrader walk 19 tiles to top up a single point of energy: measured as a
 *      creep that upgraded 2 energy at the controller and then turned round.
 *
 * The rule that produces neither is: act in place; fill before travelling; and
 * when travelling, prefer whichever target is nearer, so a creep does not walk
 * past its destination to fetch a few more energy.
 *
 * Range is computed as pure arithmetic. Movement is 8-directional, so distance
 * is Chebyshev (max of |dx|, |dy|). A creep moves one tile per tick only while
 * MOVE >= non-MOVE parts; that is a property of the body design, see body.ts.
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

/** Chebyshev distance — the number of tiles to close on a target. */
export function rangeBetween(a: Coords, b: Coords): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

interface Coords {
  x: number;
  y: number;
}

/** A candidate target, which must also be nameable in an intent. */
interface Positioned extends Coords {
  id: string;
}

type ActionKind = 'harvest' | 'transfer' | 'withdraw' | 'pickup' | 'build' | 'repair' | 'upgrade';

/** True when the creep could act on this target without moving. */
function inReach(creep: CreepView, target: Coords, kind: ActionKind): boolean {
  return rangeBetween(creep, target) <= (REACH[kind] ?? 1);
}

/**
 * Emit the action when in reach, otherwise an approach toward it.
 *
 * The approach names the target rather than a tile: sources, spawns and
 * controllers occupy solid tiles, so a creep sent to their exact coordinates
 * gets ERR_NO_PATH.
 */
function actOrApproach(creep: CreepView, target: Positioned, kind: ActionKind, amount?: number): Intent {
  if (!inReach(creep, target, kind)) {
    return { kind: 'approach', creep: creep.name, targetId: target.id, range: REACH[kind] ?? 1 };
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

/**
 * Emit the action directly.
 *
 * Used where the caller has already established reach. Distinct from
 * `actOrApproach` so the reach check never has to be faked.
 */
function act(creep: CreepView, target: Positioned, kind: Exclude<ActionKind, 'pickup'>): Intent {
  switch (kind) {
    case 'transfer':
    case 'withdraw':
      return { kind, creep: creep.name, targetId: target.id, amount: undefined };
    case 'harvest':
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
  return room.stores.filter((s) => s.energyCapacity === undefined || s.energy < s.energyCapacity);
}

/** Stores currently holding energy to take. */
function energySources(room: RoomView): StoreView[] {
  return room.stores.filter((s) => s.energy > 0);
}

/** Sources with energy available right now. */
function harvestable(room: RoomView): SourceView[] {
  return room.sources.filter((s) => s.energy > 0);
}

/** Energy sources excluding the spawn, whose stock is reserved for spawning. */
function buffers(room: RoomView): StoreView[] {
  return energySources(room).filter((s) => s.type !== 'spawn');
}

/** Where a creep can take energy, preferring a buffer over a raw source. */
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
    // No role is spawned without behaviour (see demand.ts), and a defender left
    // over from an earlier deploy has none — it will idle until its body decays.
    default:
      return null;
  }
}

/** Where a creep can take energy right now. */
interface Supply {
  target: Positioned;
  kind: 'withdraw' | 'harvest';
  /** True when the creep could act on it without moving. */
  local: boolean;
}

/** The nearest place to obtain energy, preferring a buffer over a raw source. */
function energySupply(creep: CreepView, room: RoomView): Supply | null {
  const buffer = nearest(creep, buffers(room));
  if (buffer) {
    return { target: buffer, kind: 'withdraw', local: inReach(creep, buffer, 'withdraw') };
  }

  const source = nearest(creep, harvestable(room));
  if (source) {
    return { target: source, kind: 'harvest', local: inReach(creep, source, 'harvest') };
  }

  return null;
}

/** True when there is room for more energy. */
function hasSpace(creep: CreepView): boolean {
  return creep.energy < creep.carryCapacity;
}

/**
 * Harvester: mines its own energy and delivers it.
 *
 * At BOOTSTRAP the spawn and its extensions are the only sink, which is why the
 * body carries CARRY as well as WORK. Once every store is full the controller
 * becomes the only place left for energy to go, and taking it there beats
 * idling with a full carry.
 */
function decideHarvester(creep: CreepView, task: Task | null, room: RoomView): Intent | null {
  const sink = nearest(creep, sinksFor(room));
  const controller = room.controller;
  const supply = energySupply(creep, room);

  // 1. Act on the destination.
  if (creep.energy > 0 && sink && inReach(creep, sink, 'transfer')) {
    return act(creep, sink, 'transfer');
  }
  if (creep.energy > 0 && !sink && controller?.my && inReach(creep, controller, 'upgrade')) {
    return act(creep, controller, 'upgrade');
  }

  // 2. Fill up, but only locally.
  if (hasSpace(creep) && supply?.local) return act(creep, supply.target, supply.kind);

  // 3. Travel.
  if (creep.energy > 0) {
    if (sink) return actOrApproach(creep, sink, 'transfer');
    if (controller?.my) return actOrApproach(creep, controller, 'upgrade');
  }

  const assigned =
    task?.kind === 'harvest' ? room.sources.find((s) => s.id === task.targetId) : undefined;
  const target = assigned && assigned.energy > 0 ? assigned : supply?.target;
  return target ? actOrApproach(creep, target, supply?.kind ?? 'harvest') : null;
}

/**
 * Hauler: moves buffered energy to a consumer.
 *
 * Only exists once containers do; below that it would compete with the
 * harvesters for the same pool of energy.
 */
function decideHauler(creep: CreepView, room: RoomView): Intent | null {
  const sink = nearest(creep, sinksFor(room));
  const supply = energySupply(creep, room);

  if (creep.energy > 0 && sink && inReach(creep, sink, 'transfer')) {
    return act(creep, sink, 'transfer');
  }
  if (hasSpace(creep) && supply?.local) return act(creep, supply.target, supply.kind);

  if (creep.energy > 0 && sink) return actOrApproach(creep, sink, 'transfer');
  if (!supply) return null;
  return actOrApproach(creep, supply.target, supply.kind);
}

/**
 * Upgrader: converts energy into controller progress.
 *
 * Feeds itself from buffers or a source rather than draining the spawn, whose
 * energy is what replaces dead creeps. Trading survival for progress is a bad
 * trade at every level.
 */
function decideUpgrader(creep: CreepView, room: RoomView): Intent | null {
  const controller = room.controller;
  if (!controller?.my) return null;

  const supply = energySupply(creep, room);

  // 1. Spend, while carrying and in reach. Spending the last unit is free: the
  //    creep has to travel to refill either way.
  if (creep.energy > 0 && inReach(creep, controller, 'upgrade')) {
    return act(creep, controller, 'upgrade');
  }

  // 2. Fill up, but only if the supply is at hand.
  if (hasSpace(creep) && supply?.local) return act(creep, supply.target, supply.kind);

  // 3. Travel: to the controller when carrying, otherwise to a supply.
  if (creep.energy > 0) return actOrApproach(creep, controller, 'upgrade');
  if (supply) return actOrApproach(creep, supply.target, supply.kind);
  return actOrApproach(creep, controller, 'upgrade');
}

/** Builder: fetches energy, then applies it to a construction site. */
function decideBuilder(creep: CreepView, task: Task | null, room: RoomView): Intent | null {
  const assigned =
    task?.kind === 'build' ? room.constructionSites.find((s) => s.id === task.targetId) : undefined;
  const site = assigned ?? nearest(creep, room.constructionSites);
  const supply = energySupply(creep, room);

  if (creep.energy > 0 && site && inReach(creep, site, 'build')) {
    return act(creep, site, 'build');
  }
  if (hasSpace(creep) && supply?.local) return act(creep, supply.target, supply.kind);

  if (creep.energy > 0 && site) return actOrApproach(creep, site, 'build');
  if (!supply) return null;
  return actOrApproach(creep, supply.target, supply.kind);
}
