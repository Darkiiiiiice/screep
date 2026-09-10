/**
 * Cross-tick heap.
 *
 * `global` survives between ticks, so it is where we keep per-creep working
 * state that must NOT go into `Memory`:
 *
 *   - `Memory` is capped at 2 MB and is `JSON.parse`d/`stringify`d every tick.
 *     Per-creep bookkeeping there is the classic way a Screeps AI dies at scale
 *     — the serialization cost grows with creep count and the cap is real.
 *   - Heap cost is ~0 to read and write; it is just objects.
 *
 * The trade is durability, and it is a hard rule:
 *
 *   The engine clears `global` whenever it restarts the runtime (deploys, code
 *   reloads, crashes). So NOTHING may live only here. Every heap entry must be
 *   reconstructible from `Game` + `Memory`. `heapGet` therefore takes a
 *   `recompute` fallback rather than silently returning undefined.
 */

/** Per-tick-visible shape of the heap. Bump `version` when it changes shape. */
interface Heap {
  version: number;
  /** Tick the heap was last written, so stale entries can be detected. */
  tick: number;
  /** Arbitrary per-key state, keyed by caller. */
  data: Record<string, unknown>;
}

/**
 * Bump when the shape of anything stored here changes, so entries written by an
 * older code version are discarded instead of being read as the new type.
 */
const HEAP_VERSION = 1;

const HEAP_KEY = '__screep_heap';

function heapRoot(): Heap {
  // `global` is provided by the engine; typing it loosely here keeps this file
  // free of the engine's type declarations.
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[HEAP_KEY] as Heap | undefined;

  if (existing && existing.version === HEAP_VERSION) {
    return existing;
  }

  const fresh: Heap = { version: HEAP_VERSION, tick: Game.time, data: {} };
  g[HEAP_KEY] = fresh;
  return fresh;
}

/**
 * Read a heap entry, recomputing it when absent.
 *
 * The fallback is mandatory by design: after a runtime restart the heap is
 * empty, and a caller that cannot rebuild its state from `Game`/`Memory` has a
 * latent correctness bug, not a performance one.
 */
export function heapGet<T>(key: string, recompute: () => T): T {
  const heap = heapRoot();
  const current = heap.data[key];
  if (current !== undefined) return current as T;

  const value = recompute();
  heap.data[key] = value;
  return value;
}

/** Overwrite a heap entry. */
export function heapSet<T>(key: string, value: T): void {
  heapRoot().data[key] = value;
}

/** Drop an entry (e.g. when the last creep using it dies). */
export function heapDelete(key: string): void {
  delete heapRoot().data[key];
}

/**
 * Iterate every stored key.
 *
 * Used by cleanup to evict entries whose owner no longer exists. Without this,
 * state for dead creeps accumulates for the lifetime of the runtime.
 */
export function heapKeys(): string[] {
  return Object.keys(heapRoot().data);
}
