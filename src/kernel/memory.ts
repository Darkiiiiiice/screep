/**
 * Memory schema, migration, and garbage collection.
 *
 * Three separate concerns, all driven from one place because they all hinge on
 * the same fact: `Memory` is the only state that survives a runtime restart.
 *
 *   - Schema version: lets a deploy change the Memory layout without the old
 *     shape being read as the new one.
 *   - Migration: runs once when the stored version is behind. MUST be idempotent
 *     — a tick can be cut off mid-write by the CPU limit, and the engine does
 *     not roll back.
 *   - GC: dead creeps' memory is only reclaimed incrementally. Doing it all in
 *     one tick is a visible CPU spike when a wave of creeps dies; doing it never
 *     leaks until the Memory cap bites.
 *
 * Layout rule (enforced by review, see PLAN.md §3.3):
 *   Memory holds schema version, task leases, intel summaries, and settings
 *   overrides. It does NOT hold per-creep state — that lives in the heap keyed
 *   by id, because 2 MB and a full JSON round-trip per tick are hard limits.
 */

/**
 * Bump on any change to the Memory layout below.
 *
 * 1 — initial layout.
 */
export const MEMORY_VERSION = 1;

/** Creeps whose memory is reclaimed per tick during cleanup. */
const GC_BATCH = 10;

interface MemoryRoot {
  version: number;
  /** Creep name -> whatever the AI needs to persist for it. Kept minimal. */
  creeps?: Record<string, unknown>;
  /** Task leases, owned by the task registry (M2). */
  tasks?: Record<string, unknown>;
  /** Per-room intel summaries (M4). */
  intel?: Record<string, unknown>;
  /** Runtime-tunable overrides, so behaviour can be changed without a deploy. */
  settings?: Record<string, unknown>;
}

function memory(): MemoryRoot {
  // `Memory` is provided by the engine as a plain object.
  return Memory as unknown as MemoryRoot;
}

/**
 * Bring `Memory` up to the current schema, then return it.
 *
 * Called at the start of every tick. The fast path is a single integer compare;
 * migration only runs when a deploy has bumped the version.
 */
export function initMemory(): MemoryRoot {
  const mem = memory();

  if (mem.version === MEMORY_VERSION) return mem;

  // Migration. Each step is written so that running it twice is harmless: a tick
  // killed by the CPU limit may re-run it on the next tick.
  if (mem.version === undefined || mem.version < 1) {
    mem.version = 1;
    mem.creeps ??= {};
    mem.tasks ??= {};
    mem.intel ??= {};
    mem.settings ??= {};
  }

  // Future migrations chain here, each guarded by its own version check.

  mem.version = MEMORY_VERSION;
  console.log(`[memory] migrated schema to v${MEMORY_VERSION}`);
  return mem;
}

/**
 * Reclaim memory for creeps that no longer exist.
 *
 * Incremental by design: `Game.creeps` is the source of truth for which names
 * are alive, and anything under `Memory.creeps` that is not in it is dead
 * weight. Returns the number of entries collected so the tick can report it.
 */
export function gcDeadCreeps(batch = GC_BATCH): number {
  const mem = memory();
  const creeps = mem.creeps;
  if (!creeps) return 0;

  let collected = 0;
  for (const name of Object.keys(creeps)) {
    if (collected >= batch) break;
    if (Game.creeps[name]) continue;

    delete creeps[name];
    collected += 1;
  }
  return collected;
}

/**
 * Approximate serialized size of Memory, in bytes.
 *
 * Used by the stats segment so growth is visible as a trend rather than
 * discovered when the 2 MB cap starts silently truncating writes. It costs a
 * `JSON.stringify`, so callers sample it on an interval rather than every tick.
 */
export function memoryBytes(): number {
  return JSON.stringify(Memory).length;
}
