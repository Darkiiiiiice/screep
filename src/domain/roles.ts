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
import { CRITICAL_REPAIR_FRACTION, needsRepair } from './build';

/** Reach of each action, in tiles (Chebyshev). */
const REACH: Record<string, number> = {
  harvest: 1,
  transfer: 1,
  withdraw: 1,
  build: 3,
  upgrade: 3,
  // The engine's repair range is 3, same as build's.
  repair: 3,
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

type ActionKind = 'harvest' | 'transfer' | 'withdraw' | 'build' | 'upgrade' | 'repair';

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
    case 'build':
    case 'upgrade':
    case 'repair':
      return { kind, creep: creep.name, targetId: target.id };
  }
}

/**
 * Emit the action directly.
 *
 * Used where the caller has already established reach. Distinct from
 * `actOrApproach` so the reach check never has to be faked.
 */
function act(creep: CreepView, target: Positioned, kind: ActionKind): Intent {
  switch (kind) {
    case 'transfer':
    case 'withdraw':
      return { kind, creep: creep.name, targetId: target.id, amount: undefined };
    case 'harvest':
    case 'build':
    case 'upgrade':
    case 'repair':
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

/**
 * True when the room has an income source: a living harvester, or one being built.
 *
 * Only a harvester deposits into the spawn; every other role spends what it
 * carries. So when the last harvester is gone, nothing in the colony can refill
 * the spawn, and the spawn is the only way to buy income back. That makes this
 * the one condition under which consumers must stop spending and start saving.
 */
function hasIncome(room: RoomView): boolean {
  for (const creep of room.creeps) {
    if (creep.role === 'harvester') return true;
  }
  for (const spawn of room.spawns) {
    if (spawn.spawningRole === 'harvester') return true;
  }
  return false;
}

/**
 * Save carried energy into the spawn, when the colony has lost its income.
 *
 * This closes the recovery loop, and its absence was a real hole rather than a
 * theoretical one. Measured: the sole harvester reached the end of its life, and
 * the surviving consumers mined as intended — but an upgrader spends what it
 * mines on the controller and a builder spends it on a site. Neither ever
 * deposits, so nothing could accumulate the ~250 a replacement harvester costs.
 * The colony only recovered because a dropped energy pile happened to sit beside
 * the spawn and decayed into it, one unit per tick — luck, not design.
 *
 * With this rule the loop always closes: no income means consumers mine and then
 * BANK the result, until the spawn can afford the harvester that restores income.
 *
 * @returns an intent to save, or null when this does not apply
 */
function recoverIncome(creep: CreepView, room: RoomView): Intent | null {
  if (hasIncome(room)) return null;
  return bankEnergy(creep, room);
}

/**
 * Take carried energy to the spawn, if it can hold more.
 *
 * Split out of `recoverIncome` because a second caller needs the same delivery
 * for an unrelated reason: under threat the colony banks energy instead of
 * spending it (see `decideUpgrader`). The delivery mechanics are identical, so
 * they live in one place.
 *
 * @returns an intent to deliver, or null when there is nothing to carry or
 *   nowhere to put it
 */
function bankEnergy(creep: CreepView, room: RoomView): Intent | null {
  if (creep.energy === 0) return null;

  const spawn = room.spawns[0];
  // No spawn means there is nowhere to bank; spending normally is all that is left.
  if (!spawn) return null;

  // `spawnCreep` draws on the ROOM's energy pool, not the spawn's own store, so
  // affordability and headroom are both room-level questions.
  if (spawn.energyAvailable >= spawn.energyCapacityAvailable) return null;

  return actOrApproach(creep, spawn, 'transfer');
}

/**
 * Energy the spawn must keep in hand before consumers may draw from it.
 *
 * Set to cover a full-speed harvester body, `{work, carry, move, move}` at
 * 100 + 50 + 50 + 50 = 250. Measured against `designForRole` what the colony can
 * actually buy is:
 *
 *   budget 200 → {work, carry, move}        200  (moves at 2 ticks/tile)
 *   budget 250 → {work, carry, move, move}  250  (moves at 1 tick/tile)
 *   budget 150 → null
 *
 * So the true minimum is 200 via the movement-imbalanced fallback, and 250 buys
 * the full-speed version. The reserve is set at the higher figure deliberately:
 * a reserve exists to guarantee a *recovery*, and paying 50 extra to halve the
 * replacement's travel time is worth it at the one moment it matters. Note the
 * reserve cannot lock the colony out either way — `planSpawns` budgets from
 * `energyAvailable`, so at 200–249 it will build the slower body and recover.
 *
 * This is a FLOOR, not a lock, and the distinction is the whole point:
 *
 *   - No reserve at all (an earlier version excluded the spawn unconditionally)
 *     starved a builder and an upgrader at zero energy beside a spawn holding
 *     300.
 *   - A binary reserve that engaged only once the last harvester had DIED was
 *     still too late: measured, the spawn sat at 14 with the sole harvester
 *     ~112 ticks from the end of its life. A death at that moment left the
 *     colony mining by hand from zero, with no way to buy income back.
 *
 * Holding one harvester's worth back means a replacement is affordable the
 * instant it is needed, at the cost of idling 250 of a 300–550 capacity. That
 * energy is not wasted — it is the insurance premium on the only irreplaceable
 * thing the colony owns.
 */
const SPAWN_RESERVE = 250;

/**
 * The nearest place for a CONSUMER to obtain energy.
 *
 * Stores are preferred over raw sources, so consumers do not contend with miners
 * over the same tile.
 *
 * Harvesters deliberately do NOT use this: a miner mines. See decideHarvester.
 */
function energySupply(creep: CreepView, room: RoomView): Supply | null {
  // The spawn counts, but only above the reserve. Below it, consumers mine for
  // themselves rather than spend the colony's replacement fund.
  const stores = energySources(room).filter(
    (s) => s.type !== 'spawn' || s.energy >= SPAWN_RESERVE,
  );

  const store = nearest(creep, stores);
  if (store) {
    return { target: store, kind: 'withdraw', local: inReach(creep, store, 'withdraw') };
  }

  const source = nearest(creep, harvestable(room));
  if (source) {
    return { target: source, kind: 'harvest', local: inReach(creep, source, 'harvest') };
  }

  return null;
}

/**
 * The nearest source a harvester can mine.
 *
 * Separate from `energySupply` because the two roles have opposite jobs: a miner
 * produces energy, so it mines rather than queueing behind consumers at the
 * spawn to withdraw what it could dig up itself.
 *
 * Reserving the source for harvesters also removes a contention source: the
 * measured stall had a builder and an upgrader both walking to the same source
 * that a harvester was already working.
 */
function miningSupply(creep: CreepView, room: RoomView): Supply | null {
  const source = nearest(creep, harvestable(room));
  if (!source) return null;
  return { target: source, kind: 'harvest', local: inReach(creep, source, 'harvest') };
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
  const supply = miningSupply(creep, room);

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
  const recovery = recoverIncome(creep, room);
  if (recovery) return recovery;

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

  // Threat first: stop feeding the controller and bank the energy instead.
  //
  // This is where the threat response has to live, and it previously did not
  // exist anywhere. It used to be expressed in `planTasks` as "do not create the
  // upgrade task while hostiles are present" — which changed nothing at all,
  // because this function never reads its task. Measured against the real engine:
  // with a hostile in the room the planner pruned the upgrade task every tick and
  // the controller kept advancing regardless, so the policy was inert while
  // reading like a safety feature.
  //
  // It is a WITHDRAWAL, not a defence, and calling it a defence would be a lie:
  // at RCL 2 there are no towers and a 2-ATTACK creep cannot kill an invader. The
  // honest response is to stop spending on a controller that can be let down and
  // recovered, and keep the energy where it can buy replacement creeps. Real
  // defence needs towers, which is M5.
  if (room.hostiles.length > 0) return bankEnergy(creep, room);

  // Otherwise: if the colony cannot buy a harvester, the energy this creep is
  // carrying matters far more in the spawn than in the controller.
  const recovery = recoverIncome(creep, room);
  if (recovery) return recovery;

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

/**
 * Builder: fetches energy, then applies it to a construction site.
 *
 * With no sites the builder is the colony's maintenance hand: containers are
 * the one decay-prone structure and losing one reverts the room to BOOTSTRAP,
 * so an idle builder repairs the most worn one. Sites outrank repair — a site
 * is a one-time capacity unlock while a container at half hits still works.
 */
function decideBuilder(creep: CreepView, task: Task | null, room: RoomView): Intent | null {
  const assigned =
    task?.kind === 'build' ? room.constructionSites.find((s) => s.id === task.targetId) : undefined;
  const candidates = assigned ?? nearest(creep, room.constructionSites);
  // Repair needs a target even without a leased task: at RCL 2 there may be no
  // builder when the container crosses the threshold, and the newly spawned one
  // only meets its task a tick later.
  const decayed = room.stores.filter((s) => needsRepair(s));
  // A critically worn container outranks ANY site, so it pre-empts `candidates`
  // (nulled below) rather than competing in reach order; a merely worn one only
  // matters when there is nothing to build.
  const critical = decayed.find((s) => s.hits < s.hitsMax * CRITICAL_REPAIR_FRACTION);
  const repair = critical ?? (candidates ? null : decayed[0]);
  const site = critical ? null : candidates;
  const supply = energySupply(creep, room);

  const recovery = recoverIncome(creep, room);
  if (recovery) return recovery;

  if (creep.energy > 0 && site && inReach(creep, site, 'build')) {
    return act(creep, site, 'build');
  }
  if (creep.energy > 0 && repair && inReach(creep, repair, 'repair')) {
    return act(creep, repair, 'repair');
  }
  if (hasSpace(creep) && supply?.local) return act(creep, supply.target, supply.kind);

  if (creep.energy > 0 && site) return actOrApproach(creep, site, 'build');
  if (creep.energy > 0 && repair) return actOrApproach(creep, repair, 'repair');
  if (!supply) return null;
  return actOrApproach(creep, supply.target, supply.kind);
}
