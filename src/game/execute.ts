/**
 * Intent executor: domain intents -> engine calls.
 *
 * The domain emits intent, not mechanism (see domain/types.ts). This is where
 * mechanism lives, and it is almost entirely about handling the engine's return
 * codes, which the domain is deliberately ignorant of:
 *
 *   ERR_NOT_IN_RANGE / ERR_TIRED — the target moved, or the MOVE parts are on
 *                       cooldown. The creep simply did nothing this tick and
 *                       will try again next tick. Not a failure.
 *   ERR_FULL / ERR_NOT_ENOUGH_* — the world changed under the intent. The next
 *                       tick re-plans from a fresh view, so this is not a bug.
 *
 * Codes that indicate a mistake (an unresolvable id, an unexpected error) go
 * through the log instead of being swallowed.
 */
import type { Intent } from '../domain/types';
import { heapGet } from '../kernel/heap';
import { log } from '../kernel/log';

/**
 * Engine return codes, as numeric literals.
 *
 * Deliberately NOT read from the engine's globals at module scope: doing so
 * makes the module unimportable outside a running tick (the values do not exist
 * until the engine injects them), which breaks the offline test and replay
 * harnesses. These codes are a stable part of the engine's public API — the
 * globals carry exactly these numbers.
 */
const OK = 0;
const ERR_NOT_OWNER = -1;
const ERR_BUSY = -4;
const ERR_NOT_ENOUGH_ENERGY = -6;
const ERR_INVALID_TARGET = -7;
const ERR_FULL = -8;
const ERR_NOT_IN_RANGE = -9;
const ERR_INVALID_ARGS = -10;
const ERR_TIRED = -11;
const ERR_NO_BODYPART = -12;

/**
 * Codes meaning "the world moved"; retrying next tick is the fix.
 *
 * A `Set` rather than a Record because the keys are numbers, and because two
 * engine constants share the value -6 (`ERR_NOT_ENOUGH_ENERGY` and
 * `ERR_NOT_ENOUGH_RESOURCES` are the same code) — which an object literal
 * cannot express without a duplicate key.
 */
const BENIGN: ReadonlySet<number> = new Set([ERR_NOT_IN_RANGE, ERR_TIRED, ERR_BUSY]);

/** Codes meaning the intent's premise is gone; the task should be dropped. */
const STALE: ReadonlySet<number> = new Set([
  ERR_INVALID_TARGET,
  ERR_FULL,
  ERR_NOT_ENOUGH_ENERGY,
  ERR_NO_BODYPART,
  ERR_NOT_OWNER,
]);

/**
 * No route to the target.
 *
 * Its own bucket because it is transient by nature — the usual cause is other
 * creeps occupying a corridor, not a permanent obstruction — yet it is worth
 * surfacing separately from a genuine failure, since a persistent ERR_NO_PATH
 * means a creep is stranded and that is a real problem.
 */
const NO_ROUTE = -2;

/**
 * Run one intent.
 *
 * Returns the engine's result code. The type is `number` rather than
 * `ScreepsReturnCode` because the engine's per-action unions differ —
 * `Creep.moveTo` alone can return codes outside `ScreepsReturnCode` — and
 * classifying them is all the callers need.
 */
export function execute(intent: Intent): number {
  // Spawn is the one intent with no acting creep, so it is handled before the
  // creep lookup below — which would otherwise make this branch unreachable.
  if (intent.kind === 'spawn') return spawn(intent);

  // A creep can die between the view and the execution, so its absence is
  // normal rather than exceptional.
  const creep = Game.creeps[intent.creep];
  if (!creep) return ERR_INVALID_ARGS;

  const target = Game.getObjectById(intent.targetId);
  if (!target) return ERR_INVALID_ARGS;

  // `range` lets the pathfinder pick a reachable tile next to a solid target.
  // Handing it raw coordinates of a source or spawn produced ERR_NO_PATH — the
  // creep was being sent into a tile it could never stand on.
  if (intent.kind === 'approach') {
    // Creeps are NOT ignored — `ignoreCreeps: true` makes a cached path
    // permanently wrong around an immobile blocker (measured: three creeps frozen
    // for 60+ ticks, all at zero fatigue).
    //
    // But not ignoring them creates the mirror problem, which is why a path
    // cache alone is not enough either: a cached route can run through a tile
    // that has since been occupied, and the creep then retries the same blocked
    // step until the cache expires. Measured: 12 ticks spent on a single tile
    // whose neighbour was occupied by an inert creep.
    //
    // So: cache by default, and drop the cache when the creep demonstrably stops
    // making progress. One wasted repath per obstruction, versus a full path
    // recompute every tick for every creep.
    //
    // Progress is measured over a small NEIGHBOURHOOD rather than a single tile,
    // because the failure is not always immobility: measured live, a creep
    // oscillated between two adjacent tiles for 40+ ticks, which a
    // "same tile as last tick" test never sees.
    const marks = movementMarks();
    const mark = marks[creep.name];
    const nearby = mark ? chebyshev(mark, creep.pos) <= 1 : false;
    const stalled = nearby && Game.time - (mark?.tick ?? 0) >= STALL_TICKS;

    marks[creep.name] = stalled || !nearby
      ? { x: creep.pos.x, y: creep.pos.y, tick: Game.time }
      : (mark as MovementMark);

    return creep.moveTo(target as unknown as RoomObject, {
      range: intent.range,
      reusePath: stalled ? 0 : 15,
    });
  }

  switch (intent.kind) {
    case 'harvest':
      return creep.harvest(target as Source);
    case 'transfer':
      return creep.transfer(target as AnyStoreStructure, RESOURCE_ENERGY, intent.amount);
    case 'withdraw':
      return creep.withdraw(target as AnyStoreStructure, RESOURCE_ENERGY, intent.amount);
    case 'build':
      return creep.build(target as ConstructionSite);
    case 'upgrade':
      return creep.upgradeController(target as StructureController);
    case 'repair':
      return creep.repair(target as StructureContainer);
  }
}

interface MovementMark {
  x: number;
  y: number;
  tick: number;
}

/**
 * Ticks a creep may spend going nowhere before its path cache is discarded.
 *
 * Four ticks is roughly two tiles of real movement, so reaching it while still
 * within one tile of where the run started means the route is blocked rather
 * than merely slow.
 */
const STALL_TICKS = 4;

function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Where each creep's current no-progress run started.
 *
 * Heap storage: scratch state whose only cost of loss is one extra repath.
 */
function movementMarks(): Record<string, MovementMark> {
  return heapGet<Record<string, MovementMark>>('movementMarks', () => ({}));
}

/** Queue a spawn. Body affordability is decided by the caller, not here. */
function spawn(intent: Extract<Intent, { kind: 'spawn' }>): number {
  const room = Game.rooms[intent.room];
  if (!room) return ERR_INVALID_ARGS;

  const spawnStructure = room.find(FIND_MY_SPAWNS).find((s) => s.name === intent.spawn);
  if (!spawnStructure) return ERR_INVALID_ARGS;

  return spawnStructure.spawnCreep(intent.body, intent.name, {
    memory: { role: intent.role },
  });
}

/** Classify a result code, so a caller can count outcomes without knowing them. */
export type Outcome = 'ok' | 'deferred' | 'stale' | 'no-route' | 'failed';

export function classify(code: number): Outcome {
  if (code === OK) return 'ok';
  if (BENIGN.has(code)) return 'deferred';
  if (STALE.has(code)) return 'stale';
  if (code === NO_ROUTE) return 'no-route';
  return 'failed';
}

/**
 * Execute a batch, tallying outcomes.
 *
 * The tally is what makes a mostly-working colony visible: a creep that spends
 * its life on ERR_NOT_IN_RANGE is behaving differently from one that is acting,
 * and only the ratio shows it.
 */
export interface ExecutionTally {
  attempted: number;
  succeeded: number;
  /** Not in range or on cooldown: no action happened, next tick may work. */
  deferred: number;
  /** Premise gone: the task should be dropped. */
  stale: number;
  /** No route right now; usually another creep in the way. */
  noRoute: number;
  /** Unexpected; these are worth investigating. */
  failed: number;
}

export function executeAll(intents: Intent[]): ExecutionTally {
  const tally: ExecutionTally = {
    attempted: 0,
    succeeded: 0,
    deferred: 0,
    stale: 0,
    noRoute: 0,
    failed: 0,
  };

  for (const intent of intents) {
    tally.attempted += 1;
    const outcome = classify(execute(intent));

    if (outcome === 'ok') tally.succeeded += 1;
    else if (outcome === 'deferred') tally.deferred += 1;
    else if (outcome === 'stale') tally.stale += 1;
    else if (outcome === 'no-route') tally.noRoute += 1;
    else {
      tally.failed += 1;
      // The code is the one datum that identifies the cause; without it the
      // message says only that something went wrong, which is not actionable.
      log('warn', `execute:${intent.kind}`, `${intent.kind} failed (code not classified)`);
    }
  }

  return tally;
}

export { BENIGN, STALE };
