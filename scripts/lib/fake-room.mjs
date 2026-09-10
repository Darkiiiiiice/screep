/**
 * Engine-shaped room objects built from a recorded snapshot.
 *
 * Used by the smoke harness to run the REAL bundle against a REAL room's
 * geometry, offline.
 *
 * The important property: this does not re-implement the adapter. It shapes
 * plain objects the way the engine does (`room.find`, `pos`, a `Store` with
 * `getUsedCapacity`) and the bundle's own `src/game/view.ts` converts them. So
 * the smoke run exercises the actual production code path — view building,
 * planning, leasing, decision, execution — not a parallel test-only version of
 * it.
 *
 * What it deliberately does NOT do: simulate physics. `moveTo` does not change
 * position, harvesting does not drain the source. Those cannot be verified
 * offline (see PLAN.md §4); this only proves the pipeline runs and emits sane
 * orders.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Engine constants the bundle reads.
 *
 * These are injected as globals by the real engine, so the harness must supply
 * the same ones the bundle references — a missing constant surfaces as a
 * `ReferenceError` inside a phase, which is caught by the kernel's isolation and
 * would otherwise look like "the colony did nothing".
 *
 * Values match the engine's.
 */
export const CONSTANTS = {
  FIND_SOURCES: 105,
  FIND_HOSTILE_CREEPS: 106,
  FIND_STRUCTURES: 107,
  FIND_MY_STRUCTURES: 112,
  FIND_MY_CONSTRUCTION_SITES: 113,
  FIND_MY_SPAWNS: 115,
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_CONTAINER: 'container',
  RESOURCE_ENERGY: 'energy',
};

/** The newest recorded snapshot, or null when none has been taken. */
export function newestSnapshot(dir = 'test/fixtures/rooms') {
  const abs = resolve(process.cwd(), dir);
  const files = readdirSync(abs).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) return null;
  const latest = files.at(-1);
  return JSON.parse(readFileSync(resolve(abs, latest), 'utf8'));
}

/**
 * Energy cost per body part.
 *
 * These are the engine's constants, not our domain's copy of them — the harness
 * needs its own ground truth to check the bundle's arithmetic against, otherwise
 * a wrong cost table in `src/domain/body.ts` would agree with itself and pass.
 */
const PART_COST = {
  tough: 10,
  move: 50,
  carry: 50,
  work: 100,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
};

/** Cost of a body, per the engine's part costs. */
export function bodyCost(body) {
  let total = 0;
  for (const part of body) total += PART_COST[part] ?? 0;
  return total;
}

/** Minimal `Store` matching the engine's read surface. */
function storeOf(energy, capacity) {
  return {
    energy,
    getUsedCapacity: () => energy,
    getCapacity: () => capacity ?? null,
  };
}

/**
 * Build an engine-shaped room from a snapshot.
 *
 * @param snapshot  raw `game/room-objects` response
 * @param opts      creeps to place, and a hook to observe spawn requests
 */
export function buildRoom(snapshot, opts = {}) {
  const objects = snapshot.objects;
  const creeps = opts.creeps ?? [];

  const sourceObjects = objects.filter((o) => o.type === 'source');
  const spawnObjects = objects.filter((o) => o.type === 'spawn');
  const controllerObject = objects.find((o) => o.type === 'controller');

  // Energy capacity caps the body size; energy on hand decides whether a spawn
  // can be paid for right now. The engine exposes both on the room.
  let capacityAvailable = 0;
  let energyAvailable = 0;
  for (const o of objects) {
    const cap = o.storeCapacityResource?.energy;
    if (typeof cap === 'number') capacityAvailable += cap;
    energyAvailable += o.store?.energy ?? 0;
  }

  const storeStructures = [];
  for (const o of objects) {
    if (o.storeCapacityResource === undefined && o.type !== 'container') continue;
    storeStructures.push({
      id: o._id,
      structureType: o.type,
      pos: { x: o.x, y: o.y, roomName: o.room },
      store: storeOf(o.store?.energy ?? 0, o.storeCapacityResource?.energy),
    });
  }

  const spawns = spawnObjects.map((o) => ({
    id: o._id,
    name: o.name,
    structureType: 'spawn',
    pos: { x: o.x, y: o.y, roomName: o.room },
    store: storeOf(o.store?.energy ?? 0, o.storeCapacityResource?.energy),
    spawning: null,
    spawnCreep(body, name, options) {
      // Record the request so the harness can assert on it, and register the
      // creep so the game state reflects reality on the next tick.
      opts.onSpawn?.({ body, name, memory: options?.memory });
      this.spawning = { name, remainingTime: 3 };
      return 0; // OK
    },
  }));

  const sources = sourceObjects.map((o) => ({
    id: o._id,
    pos: { x: o.x, y: o.y, roomName: o.room },
    energy: o.energy,
    ticksToRegeneration: o.ticksToRegeneration ?? 0,
  }));

  const controller = controllerObject
    ? {
        id: controllerObject._id,
        pos: { x: controllerObject.x, y: controllerObject.y, roomName: controllerObject.room },
        level: controllerObject.level,
        my: true,
        ticksToDowngrade: Math.max(
          0,
          (controllerObject.downgradeTime ?? snapshot.gameTime) - snapshot.gameTime,
        ),
        progress: controllerObject.progress ?? 0,
        progressTotal: controllerObject.progressTotal || 200,
      }
    : undefined;

  const room = {
    name: snapshot.room,
    controller,
    energyAvailable,
    energyCapacityAvailable: capacityAvailable,
    find(type) {
      switch (type) {
        case CONSTANTS.FIND_MY_STRUCTURES:
          return [...spawns];
        case CONSTANTS.FIND_STRUCTURES:
          return [...storeStructures];
        case CONSTANTS.FIND_SOURCES:
          return [...sources];
        case CONSTANTS.FIND_MY_CONSTRUCTION_SITES:
        case CONSTANTS.FIND_HOSTILE_CREEPS:
          return [];
        case CONSTANTS.FIND_MY_SPAWNS:
          return [...spawns];
        default:
          return [];
      }
    },
    findMyStructures: () => [],
  };

  const allObjects = [...spawns, ...sources, ...storeStructures];
  if (controller) allObjects.push(controller);

  return { room, spawns, sources, controller, objects: allObjects, creeps };
}

/** An engine-shaped creep, with the store surface the adapter reads. */
export function buildCreep(name, role, x, y, roomName, energy = 0) {
  return {
    name,
    memory: { role },
    body: [{ type: 'work' }, { type: 'carry' }, { type: 'move' }],
    pos: { x, y, roomName },
    ticksToLive: 1500,
    store: storeOf(energy, 50),
    // Every action returns OK so the harness can assert on intent construction;
    // physics is out of scope offline.
    harvest: () => 0,
    transfer: () => 0,
    withdraw: () => 0,
    build: () => 0,
    repair: () => 0,
    upgradeController: () => 0,
    pickup: () => 0,
    moveTo: () => 0,
  };
}
