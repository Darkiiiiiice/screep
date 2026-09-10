/**
 * Snapshot -> RoomView, for offline replay.
 *
 * The other half of verification track B. `src/game/view.ts` builds a RoomView
 * from live engine objects; this builds the same shape from a recorded
 * `GET /api/game/room-objects` response, so the pure domain can be driven
 * against a REAL room's layout offline.
 *
 * The two sources disagree in ways worth knowing, and this file exists to absorb
 * them so the domain never sees the difference:
 *
 *   - The REST API returns database fields, not the in-game API. A controller
 *     carries `downgradeTime` (an absolute game time) where the game exposes
 *     `ticksToDowngrade` (a relative count), and `user` where the game exposes
 *     `my`. Both are normalised here.
 *   - Structures expose `store`/`storeCapacityResource` as plain objects, not
 *     the `Store` class with `getUsedCapacity()`.
 *   - The response has no concept of "owned" — it is everything in the room.
 */
import type {
  ConstructionSiteView,
  ControllerView,
  CreepView,
  RoomView,
  SourceView,
  SpawnView,
  StoreView,
} from '../../src/domain/types';

/** A raw object as returned by `GET /api/game/room-objects`. */
export interface RawObject {
  _id: string;
  type: string;
  room: string;
  x: number;
  y: number;
  [key: string]: unknown;
}

export interface RawSnapshot {
  room: string;
  shard: string;
  gameTime: number;
  objectCount: number;
  objects: RawObject[];
}

/** The account whose objects are ours, taken from the snapshot's own records. */
function ownerId(snapshot: RawSnapshot): string | null {
  const spawn = snapshot.objects.find((o) => o.type === 'spawn');
  return typeof spawn?.user === 'string' ? spawn.user : null;
}

/** Energy held, across the two shapes the API uses. */
function rawEnergy(object: RawObject): number {
  const store = object.store as Record<string, number> | undefined;
  if (store && typeof store.energy === 'number') return store.energy;
  return typeof object.energy === 'number' ? object.energy : 0;
}

/** Energy capacity, or undefined when the structure does not store energy. */
function rawCapacity(object: RawObject): number | undefined {
  const resource = object.storeCapacityResource as Record<string, number> | undefined;
  if (resource && typeof resource.energy === 'number') return resource.energy;
  if (typeof object.storeCapacity === 'number') return object.storeCapacity;
  return undefined;
}

function toStore(object: RawObject): StoreView {
  return {
    id: object._id,
    type: object.type,
    x: object.x,
    y: object.y,
    room: object.room,
    energy: rawEnergy(object),
    energyCapacity: rawCapacity(object),
  };
}

function toSource(object: RawObject): SourceView {
  return {
    id: object._id,
    x: object.x,
    y: object.y,
    room: object.room,
    energy: typeof object.energy === 'number' ? object.energy : 0,
    ticksToRegeneration:
      typeof object.ticksToRegeneration === 'number' ? object.ticksToRegeneration : 0,
  };
}

/**
 * Normalise a controller.
 *
 * `downgradeTime` is absolute; the domain wants the relative count the in-game
 * API provides. Subtracting is the whole reason the snapshot records game time,
 * and getting it wrong makes the downgrade-urgency priority fire permanently.
 */
function toController(object: RawObject, gameTime: number, owner: string | null): ControllerView {
  const downgradeTime = typeof object.downgradeTime === 'number' ? object.downgradeTime : gameTime;
  const progressTotal = typeof object.progressTotal === 'number' ? object.progressTotal : 0;

  return {
    id: object._id,
    x: object.x,
    y: object.y,
    level: typeof object.level === 'number' ? object.level : 0,
    my: owner !== null && object.user === owner,
    ticksToDowngrade: Math.max(0, downgradeTime - gameTime),
    progress: typeof object.progress === 'number' ? object.progress : 0,
    // The API reports 0 for a freshly claimed controller; the engine's real
    // value is the energy needed for the next level. 200 is RCL 1 -> 2.
    progressTotal: progressTotal > 0 ? progressTotal : 200,
  };
}

function toSpawn(
  object: RawObject,
  room: RoomView,
  capacityAvailable: number,
  energyAvailable: number,
): SpawnView {
  const spawning = object.spawning as { name?: string } | null | undefined;
  return {
    id: object._id,
    name: typeof object.name === 'string' ? object.name : 'Spawn',
    x: object.x,
    y: object.y,
    room: object.room,
    energy: rawEnergy(object),
    energyAvailable,
    energyCapacityAvailable: capacityAvailable,
    spawning: Boolean(spawning),
    spawningName: spawning?.name ?? null,
    // The snapshot does not carry the spawn queue's memory; callers that need it
    // must supply creeps explicitly (see `toRoomView`'s `creeps` option).
    spawningRole: null,
    spawnTicksRemaining:
      typeof (spawning as { remainingTime?: number } | undefined)?.remainingTime === 'number'
        ? ((spawning as { remainingTime: number }).remainingTime)
        : 0,
  };
}

function toSite(object: RawObject): ConstructionSiteView {
  return {
    id: object._id,
    x: object.x,
    y: object.y,
    room: object.room,
    structureType: typeof object.structureType === 'string' ? object.structureType : 'road',
    progress: typeof object.progress === 'number' ? object.progress : 0,
    progressTotal: typeof object.progressTotal === 'number' ? object.progressTotal : 1,
  };
}

/** Structure types the colony can draw from or deliver to. */
const STORE_TYPES: Record<string, true> = {
  spawn: true,
  extension: true,
  container: true,
  storage: true,
  terminal: true,
  link: true,
  tower: true,
  lab: true,
  nuker: true,
  powerSpawn: true,
  factory: true,
};

export interface ReplayOptions {
  /** Creeps to place in the room. A raw snapshot has none of its own. */
  creeps?: CreepView[];
  /** Override the controller level, to exercise states the snapshot predates. */
  level?: number;
}

/**
 * Build a RoomView from a recorded snapshot.
 *
 * Collections are sorted by id, matching `viewRoom`, so a replayed room produces
 * the same tie-breaks a live one would.
 */
export function toRoomView(snapshot: RawSnapshot, options: ReplayOptions = {}): RoomView {
  const owner = ownerId(snapshot);
  const objects = snapshot.objects.slice().sort((a, b) => (a._id < b._id ? -1 : 1));

  const spawnObjects = objects.filter((o) => o.type === 'spawn');
  const storeObjects = objects.filter((o) => STORE_TYPES[o.type] === true);

  // `energyCapacityAvailable` is the total energy capacity of built structures,
  // which is what caps a spawn's body budget. Derived the same way the engine
  // does, so an offline replay cannot ask for a body the spawn could not afford.
  let capacityAvailable = 0;
  let energyAvailable = 0;
  for (const object of storeObjects) {
    capacityAvailable += rawCapacity(object) ?? 0;
    energyAvailable += rawEnergy(object);
  }

  const controllerObject = objects.find((o) => o.type === 'controller');
  const controller = controllerObject
    ? toController(controllerObject, snapshot.gameTime, owner)
    : null;

  const room: RoomView = {
    name: snapshot.room,
    controller: controller && options.level !== undefined
      ? { ...controller, level: options.level }
      : controller,
    spawns: [],
    sources: objects.filter((o) => o.type === 'source').map(toSource),
    stores: storeObjects.map(toStore),
    constructionSites: objects
      .filter((o) => o.type === 'constructionSite')
      .map(toSite),
    creeps: options.creeps ?? [],
    hostiles: [],
  };

  room.spawns = spawnObjects.map((o) => toSpawn(o, room, capacityAvailable, energyAvailable));
  return room;
}
