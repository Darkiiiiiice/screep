/**
 * Tick-scoped and static caches.
 *
 * Two very different lifetimes, deliberately kept apart:
 *
 *   1. Object cache — valid for the CURRENT tick only. `Game.getObjectById` is
 *      not free and a tick typically looks up the same id many times (a source
 *      referenced by every harvester assigned to it). Cleared at tick start
 *      because ids can die between ticks and a stale object reference is a
 *      silent correctness bug.
 *
 *   2. Static cache — terrain and CostMatrix. These only change on construction
 *      or destruction, which is rare, so they are recomputed every N ticks
 *      rather than every tick. PathFinder is the single most CPU-expensive
 *      thing we do; recomputing its input every tick would blow a 20 ms budget
 *      on its own.
 */
import { heapGet, heapSet } from './heap';

/**
 * Ticks between static-cache refreshes.
 *
 * Tuned against cost-per-recompute vs staleness tolerance: a CostMatrix that is
 * a handful of ticks out of date produces slightly suboptimal paths, which is
 * far cheaper than rebuilding it every tick.
 */
const STATIC_TTL = 50;

export interface StaticEntry<T> {
  value: T;
  computedAt: number;
}

/**
 * Read a value that only changes slowly, recomputing every `STATIC_TTL` ticks.
 *
 * Stored in the heap, not in Memory: a CostMatrix is a large numeric structure
 * and has no business being JSON-serialized into a 2 MB budget.
 *
 * @param key cache key, namespaced by the caller (e.g. `terrain:W1N1`)
 * @param recompute producer, called only when the entry is missing or stale
 */
export function staticGet<T>(key: string, recompute: () => T): T {
  const entry = heapGet<StaticEntry<T>>(`static:${key}`, () => ({
    value: recompute(),
    computedAt: Game.time,
  }));

  if (Game.time - entry.computedAt < STATIC_TTL) {
    return entry.value;
  }

  const refreshed: StaticEntry<T> = { value: recompute(), computedAt: Game.time };
  heapSet(`static:${key}`, refreshed);
  return refreshed.value;
}

/** Force the next `staticGet` for a key to recompute (e.g. after a build). */
export function staticInvalidate(key: string): void {
  heapSet<StaticEntry<unknown>>(`static:${key}`, { value: undefined, computedAt: -Infinity });
}

/**
 * Look up a game object by id, memoized for the current tick.
 *
 * Returns null for ids that no longer resolve — an id can outlive its object
 * (a creep named in Memory whose body was destroyed), and callers must handle
 * that rather than assume a live object.
 */
export function objectById<T extends { id: string }>(id: string): T | null {
  const cache = tickCache();
  const hit = cache.get(id);
  if (hit !== undefined) return hit as T | null;

  const found = (Game.getObjectById(id) as T | null) ?? null;
  cache.set(id, found);
  return found;
}

/**
 * Per-tick object cache.
 *
 * Keyed into the heap under a tick-stamped entry so it is dropped implicitly
 * when the tick changes, which avoids relying on a reset call happening.
 */
function tickCache(): Map<string, unknown> {
  const entry = heapGet<{ tick: number; map: Map<string, unknown> }>('objectCache', () => ({
    tick: Game.time,
    map: new Map(),
  }));

  if (entry.tick !== Game.time) {
    entry.tick = Game.time;
    entry.map.clear();
  }
  return entry.map;
}

/** Number of ids memoized this tick, for profiling. */
export function objectCacheSize(): number {
  return tickCache().size;
}
