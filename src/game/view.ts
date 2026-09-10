/**
 * Live adapter: engine globals -> domain views.
 *
 * This is the only place that reads engine objects to build a domain view, and
 * it is deliberately mechanical. It is also where the engine's *implicit*
 * knowledge gets made explicit — two examples that are easy to get wrong and
 * impossible to test offline:
 *
 *   1. `controller.ticksToDowngrade` is a VIEW-only field. Reconstructing a room
 *      from raw data requires subtracting game time from an absolute timestamp.
 *      Normalising it here means the domain only ever sees a relative count.
 *
 *   2. `room.energyCapacityAvailable` is the budget a spawn may spend, and it
 *      reflects extensions that are BUILT, not merely unlocked by the level.
 *      Using `room.energyCapacityAvailable` directly is correct; summing
 *      capacities by hand drifts as extensions come and go.
 */
import type {
  ConstructionSiteView,
  ControllerView,
  CreepView,
  RoomView,
  SourceView,
  SpawnView,
  StoreView,
} from '../domain/types';

/**
 * A structure that may carry a Store.
 *
 * `AnyStructure` includes the controller, which has no `store` at all — hence
 * the optional shape and the `in` checks rather than direct access.
 */
type StorableStructure = AnyStructure & { store?: StoreDefinition };

/** Structures the colony can draw energy from or deliver to. */
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

/**
 * Energy held by a structure.
 *
 * `store` (a Store object) is the modern shape; `energy` is the legacy field
 * still present on some structures. Both are checked rather than assuming one,
 * because getting this wrong silently reports a full container as empty and the
 * colony hauls nothing.
 */
function energyOf(structure: StorableStructure): number {
  const store = structure.store;
  if (store && typeof store.getUsedCapacity === 'function') {
    return store.getUsedCapacity(RESOURCE_ENERGY);
  }
  if (store && typeof store.energy === 'number') return store.energy;
  const legacy = (structure as unknown as { energy?: number }).energy;
  return typeof legacy === 'number' ? legacy : 0;
}

/** Total energy a structure can hold, or undefined when it is unbounded. */
function energyCapacityOf(structure: StorableStructure): number | undefined {
  const store = structure.store;
  if (store && typeof store.getCapacity === 'function') {
    const capacity = store.getCapacity(RESOURCE_ENERGY);
    // `getCapacity` returns null for structures with unlimited energy storage.
    return capacity ?? undefined;
  }
  const resourceCapacity = (structure as unknown as { storeCapacityResource?: Record<string, number> })
    .storeCapacityResource;
  if (resourceCapacity && typeof resourceCapacity.energy === 'number') {
    return resourceCapacity.energy;
  }
  const general = (structure as unknown as { storeCapacity?: number }).storeCapacity;
  return typeof general === 'number' ? general : undefined;
}

function viewStore(structure: StorableStructure): StoreView {
  return {
    id: structure.id,
    type: structure.structureType,
    x: structure.pos.x,
    y: structure.pos.y,
    room: structure.pos.roomName,
    energy: energyOf(structure),
    energyCapacity: energyCapacityOf(structure),
  };
}

function viewController(controller: StructureController | undefined): ControllerView | null {
  if (!controller) return null;
  return {
    id: controller.id,
    x: controller.pos.x,
    y: controller.pos.y,
    level: controller.level,
    my: controller.my === true,
    // Normalised to a relative count: the domain reasons about "how long until
    // this downgrades", not about absolute game time.
    ticksToDowngrade: controller.ticksToDowngrade,
    progress: controller.progress,
    progressTotal: controller.progressTotal,
  };
}

function viewSpawn(spawn: StructureSpawn, room: Room): SpawnView {
  return {
    id: spawn.id,
    name: spawn.name,
    x: spawn.pos.x,
    y: spawn.pos.y,
    room: spawn.pos.roomName,
    energy: energyOf(spawn),
    // Read from the room, not summed from the spawn: `spawnCreep` draws on the
    // room's whole energy pool, so the spawn's own store is the wrong number.
    energyAvailable: room.energyAvailable,
    // The body is sized against this: the sum of all BUILT energy capacity,
    // which is why an extension only counts once it exists.
    energyCapacityAvailable: room.energyCapacityAvailable,
    spawning: spawn.spawning !== null,
    spawningName: spawn.spawning?.name ?? null,
    // Read from Memory rather than tracked separately: the role is recorded at
    // `spawnCreep` time, so the engine is already the source of truth.
    spawningRole: spawn.spawning ? (Memory.creeps[spawn.spawning.name]?.role ?? null) : null,
    spawnTicksRemaining: spawn.spawning?.remainingTime ?? 0,
  };
}

function viewSource(source: Source): SourceView {
  return {
    id: source.id,
    x: source.pos.x,
    y: source.pos.y,
    room: source.pos.roomName,
    energy: source.energy,
    ticksToRegeneration: source.ticksToRegeneration ?? 0,
  };
}

function viewSite(site: ConstructionSite): ConstructionSiteView {
  return {
    id: site.id,
    x: site.pos.x,
    y: site.pos.y,
    room: site.pos.roomName,
    structureType: site.structureType,
    progress: site.progress,
    progressTotal: site.progressTotal,
  };
}

function viewCreep(creep: Creep): CreepView {
  const parts: Partial<Record<string, number>> = {};
  for (const part of creep.body) {
    parts[part.type] = (parts[part.type] ?? 0) + 1;
  }

  return {
    name: creep.name,
    role: creep.memory.role ?? 'harvester',
    x: creep.pos.x,
    y: creep.pos.y,
    room: creep.pos.roomName,
    ticksToLive: creep.ticksToLive ?? 1500,
    energy: creep.store.getUsedCapacity(RESOURCE_ENERGY),
    carryCapacity: creep.store.getCapacity(RESOURCE_ENERGY),
    parts,
    taskId: creep.memory.taskId ?? null,
  };
}

/**
 * Build a domain view of one room.
 *
 * Every collection is sorted by id before it leaves here. The engine's
 * `find()` order is stable but unspecified, so two orderings of the same room —
 * live versus a replayed snapshot — could differ. Anything downstream that
 * breaks a tie by position (task creation order, nearest-target selection) would
 * then behave differently in replay than in production, which would make the
 * whole offline harness worthless.
 *
 * @param room       the room to snapshot
 * @param allCreeps  every owned creep, so the view includes creeps standing in
 *   other rooms or in transit — a creep that left mid-task must still be counted
 *   against demand, or the spawn manager will over-recruit.
 */
export function viewRoom(room: Room, allCreeps: Creep[]): RoomView {
  const spawns: SpawnView[] = [];
  const stores: StoreView[] = [];
  const sites: ConstructionSiteView[] = [];

  for (const structure of room.find(FIND_MY_STRUCTURES)) {
    if (structure.structureType === STRUCTURE_SPAWN) {
      spawns.push(viewSpawn(structure as StructureSpawn, room));
    }
    if (STORE_TYPES[structure.structureType] === true) {
      stores.push(viewStore(structure));
    }
  }

  // Containers are not owned structures, so `find(FIND_MY_STRUCTURES)` misses
  // them entirely — and a container IS the ESTABLISHED economy's whole point.
  for (const structure of room.find(FIND_STRUCTURES)) {
    if (structure.structureType !== STRUCTURE_CONTAINER) continue;
    stores.push(viewStore(structure));
  }

  for (const site of room.find(FIND_MY_CONSTRUCTION_SITES)) sites.push(viewSite(site));

  return {
    name: room.name,
    controller: viewController(room.controller),
    spawns: byId(spawns),
    sources: byId(room.find(FIND_SOURCES).map(viewSource)),
    stores: byId(stores),
    constructionSites: byId(sites),
    creeps: byId(allCreeps.filter((c) => c.pos.roomName === room.name).map(viewCreep), (c) => c.name),
    hostiles: byId(
      room.find(FIND_HOSTILE_CREEPS).map((c) => ({ id: c.id, x: c.pos.x, y: c.pos.y })),
    ),
  };
}

/** Sort by a stable key so replay and live runs agree. */
function byId<T>(items: T[], keyOf: (item: T) => string = (item) => (item as { id: string }).id): T[] {
  return items.slice().sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka === kb) return 0;
    return ka < kb ? -1 : 1;
  });
}

/** Rooms the account owns a controller in. */
export function ownedRooms(): Room[] {
  const rooms: Room[] = [];
  for (const name of Object.keys(Game.rooms)) {
    const room = Game.rooms[name];
    if (room?.controller?.my === true) rooms.push(room);
  }
  return rooms;
}
