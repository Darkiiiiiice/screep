/**
 * Domain ports: the only shapes that cross between pure logic and the engine.
 *
 * `src/domain/**` may not import the engine (enforced by eslint; see
 * PLAN.md §4). So the domain does not read `Game` and does not call creep
 * methods. Instead:
 *
 *   game/  --snapshot()-->  domain decides  --intents-->  game/  executes
 *
 * Both directions are plain, serializable data. That is what makes the domain
 * testable without an engine, and what lets a recorded live snapshot be replayed
 * offline (verification track B) to assert the intent sequence it produces.
 *
 * Keep these types free of engine class types. If a field needs an engine
 * object, it carries the object's `id` string instead.
 */

/**
 * Body part names.
 *
 * A closed union rather than plain strings: the domain can then only ever
 * produce a body the engine will accept, and the adapter's conversion to
 * `BodyPartConstant` needs no runtime validation.
 */
export type BodyPart =
  | 'tough'
  | 'move'
  | 'carry'
  | 'work'
  | 'attack'
  | 'ranged_attack'
  | 'heal'
  | 'claim';

/** A list of body parts, in engine order. */
export type Body = BodyPart[];

/** A creep, as the domain sees it. */
export interface CreepView {
  /** Stable name — the identity used in Memory and in task leases. */
  name: string;
  /**
   * Role assigned at spawn time, read back from the creep's memory.
   *
   * Null when unknown: a creep whose memory was lost (or one we did not spawn)
   * must NOT default to any productive role. An earlier default of 'harvester'
   * made an inert foreign creep count as income capacity, which zeroed the
   * harvester gap at BOOTSTRAP — the colony then spent its first 450 ticks
   * spawning upgraders while income ran at 1 energy/tick on self-mining
   * consumers, and it survived only because upgraders happen to have WORK parts.
   */
  role: string | null;
  /** Position, kept as raw coordinates so no RoomPosition crosses the port. */
  x: number;
  y: number;
  room: string;
  /** Energy carried right now. */
  energy: number;
  /** Total carry capacity, i.e. the upper bound on `energy`. */
  carryCapacity: number;
  /**
   * Ticks of life left, or null when unknown (a creep we did not spawn).
   *
   * Exposed so the spawn planner can treat a creep that is about to die of old
   * age as already gone and start its replacement BEFORE the income stops —
   * measured live, a harvester that dies first and is replaced after costs its
   * full spawn duration of zero income every generation.
   */
  ticksToLive: number | null;
  /** Body part counts, e.g. `{ work: 2, carry: 1, move: 1 }`. */
  parts: Partial<Record<string, number>>;
  /** Task currently leased to this creep, if any. */
  taskId: string | null;
}

/** A source, as the domain sees it. */
export interface SourceView {
  id: string;
  x: number;
  y: number;
  room: string;
  /** Energy remaining before regeneration. */
  energy: number;
  /** Ticks until it refills; 0 means available now. */
  ticksToRegeneration: number;
}

/** Energy-bearing structure the colony can draw from or deliver to. */
export interface StoreView {
  id: string;
  /** Engine structure type, e.g. `extension`, `container`, `storage`. */
  type: string;
  x: number;
  y: number;
  room: string;
  energy: number;
  /** `undefined` for structures that accept unlimited energy. */
  energyCapacity: number | undefined;
  /**
   * Current and maximum hit points.
   *
   * Every engine structure carries them, so they are filled for all stores
   * uniformly. The decay-prone ones (containers) are what the planner reads;
   * everything else holds a steady value and never triggers repair.
   */
  hits: number;
  hitsMax: number;
}

export interface ControllerView {
  id: string;
  /** Position, so the domain can reason about reach without the engine. */
  x: number;
  y: number;
  level: number;
  my: boolean;
  /** Ticks before the controller downgrades if not upgraded. */
  ticksToDowngrade: number;
  /** Total energy progress toward the next level, out of `progressTotal`. */
  progress: number;
  progressTotal: number;
}

export interface ConstructionSiteView {
  id: string;
  x: number;
  y: number;
  room: string;
  structureType: string;
  /** Remaining energy needed to complete the site. */
  progress: number;
  progressTotal: number;
}

/** A spawn, as the domain sees it for scheduling purposes. */
export interface SpawnView {
  id: string;
  name: string;
  x: number;
  y: number;
  room: string;
  /** Energy currently loaded into the spawn. */
  energy: number;
  /**
   * Energy the room can spend right now (spawn + extensions).
   *
   * Distinct from `energyCapacityAvailable`, and the two are used differently:
   * the body is *sized* against capacity but only requested when this covers its
   * cost, because `spawnCreep` draws on current energy and a body the room
   * cannot pay for fails with ERR_NOT_ENOUGH_ENERGY.
   */
  energyAvailable: number;
  /** Energy the room's spawn + extensions can hold in total. */
  energyCapacityAvailable: number;
  /** Set while the spawn is mid-creation; the domain must not queue another. */
  spawning: boolean;
  /** Name of the creep being built, or null when idle. */
  spawningName: string | null;
  /** Role of the creep being built, so it counts against demand before hatching. */
  spawningRole: string | null;
  /** Remaining ticks in the current spawn operation. */
  spawnTicksRemaining: number;
}

/** Everything the domain needs about one owned room. */
export interface RoomView {
  name: string;
  controller: ControllerView | null;
  spawns: SpawnView[];
  sources: SourceView[];
  /** Structures that can hold energy (spawns, extensions, containers, storage). */
  stores: StoreView[];
  constructionSites: ConstructionSiteView[];
  creeps: CreepView[];
  /** Hostile creeps visible in the room, for defensive response. */
  hostiles: { id: string; x: number; y: number }[];
}

/* ------------------------------------------------------------------------- */
/* Intents: what the domain asks the engine to do.                            */
/* ------------------------------------------------------------------------- */

/**
 * Every intent names a subject by id or name, plus plain parameters. The
 * adapter is responsible for resolving them and for handling failures
 * (`ERR_NOT_IN_RANGE`, a dead target) — the domain expresses intent, not
 * mechanism, so it never has to reason about the engine's return codes.
 */
export type Intent =
  | { kind: 'harvest'; creep: string; targetId: string }
  | { kind: 'transfer'; creep: string; targetId: string; amount: number | undefined }
  | { kind: 'withdraw'; creep: string; targetId: string; amount: number | undefined }
  | { kind: 'build'; creep: string; targetId: string }
  | { kind: 'upgrade'; creep: string; targetId: string }
  /**
   * Restore hit points on a damaged structure.
   *
   * Containers are the one decay-prone structure the colony builds; a decayed
   * one reverts the room to BOOTSTRAP, so maintenance is load-bearing. The
   * engine's repair range is 3, same as build.
   */
  | { kind: 'repair'; creep: string; targetId: string }
  /**
   * Move into `range` of a target.
   *
   * Deliberately names the target rather than a destination tile: sources,
   * spawns and controllers all occupy solid tiles, so a creep told to move to
   * their exact position gets ERR_NO_PATH. Naming the target and the desired
   * range lets the engine path to the nearest reachable tile, which is what the
   * action actually needs.
   */
  | { kind: 'approach'; creep: string; targetId: string; range: number }
  | { kind: 'spawn'; room: string; spawn: string; body: BodyPart[]; name: string; role: string };

/** Role names. String literals rather than an enum so they survive `JSON`. */
export type Role = 'harvester' | 'hauler' | 'upgrader' | 'builder' | 'defender';

/** Colony lifecycle stage, derived from the controller level. */
export type ColonyState = 'BOOTSTRAP' | 'ESTABLISHED' | 'MATURE' | 'EXPANSION';
