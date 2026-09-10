import { afterEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { heapGet, heapSet, heapDelete, heapKeys } from '@/kernel/heap';
import { staticGet, staticInvalidate, objectById, objectCacheSize } from '@/kernel/cache';

let engine: FakeEngine | undefined;

afterEach(() => {
  engine?.restore();
  engine = undefined;
});

describe('heap', () => {
  it('recomputes when the entry is absent', () => {
    engine = installFakeEngine();
    let calls = 0;
    const value = heapGet('k', () => {
      calls += 1;
      return 42;
    });
    expect(value).toBe(42);
    expect(calls).toBe(1);
  });

  it('returns the stored entry without recomputing', () => {
    engine = installFakeEngine();
    let calls = 0;
    const compute = (): number => {
      calls += 1;
      return 7;
    };
    heapGet('k', compute);
    expect(heapGet('k', compute)).toBe(7);
    expect(calls).toBe(1);
  });

  it('discards entries written by an older heap version', () => {
    // The engine clears `global` on a runtime restart, but a deploy replaces the
    // code while `global` may survive with the old layout. Reading a stale shape
    // as the new type is a silent corruption, so the version gates it.
    engine = installFakeEngine();
    (globalThis as Record<string, unknown>).__screep_heap = {
      version: 0,
      tick: 1,
      data: { k: 'stale' },
    };
    let calls = 0;
    const value = heapGet('k', () => {
      calls += 1;
      return 'fresh';
    });
    expect(value).toBe('fresh');
    expect(calls).toBe(1);
  });

  it('exposes keys so cleanup can evict orphaned entries', () => {
    engine = installFakeEngine();
    heapSet('a', 1);
    heapSet('b', 2);
    expect(heapKeys().sort()).toEqual(['a', 'b']);

    heapDelete('a');
    expect(heapKeys()).toEqual(['b']);
  });
});

describe('static cache', () => {
  it('serves a cached value without recomputing within the TTL', () => {
    engine = installFakeEngine();
    let calls = 0;
    const compute = (): number => {
      calls += 1;
      return 5;
    };

    expect(staticGet('terrain:W1N1', compute)).toBe(5);
    engine.advanceTick();
    expect(staticGet('terrain:W1N1', compute)).toBe(5);
    expect(calls).toBe(1);
  });

  it('recomputes once the TTL has elapsed', () => {
    // Terrain and CostMatrix only change on construction, so they are refreshed
    // on an interval rather than every tick — PathFinder input is the most
    // expensive thing we compute and cannot be rebuilt at 20 ms/tick.
    engine = installFakeEngine();
    let calls = 0;
    const compute = (): number => {
      calls += 1;
      return calls;
    };

    staticGet('cm:W1N1', compute);
    for (let i = 0; i < 50; i += 1) engine.advanceTick();
    expect(staticGet('cm:W1N1', compute)).toBe(2);
    expect(calls).toBe(2);
  });

  it('invalidates on demand, e.g. after a structure is built', () => {
    engine = installFakeEngine();
    let calls = 0;
    const compute = (): number => {
      calls += 1;
      return calls;
    };

    staticGet('cm:W1N1', compute);
    staticInvalidate('cm:W1N1');
    expect(staticGet('cm:W1N1', compute)).toBe(2);
  });
});

describe('tick-scoped object cache', () => {
  it('memoizes lookups within a tick', () => {
    engine = installFakeEngine();
    const creep = { id: 'c1', name: 'Bob' };
    engine.addObject('c1', creep);

    expect(objectById('c1')).toBe(creep);
    expect(objectById('c1')).toBe(creep);
    expect(objectCacheSize()).toBe(1);
  });

  it('drops the cache when the tick changes', () => {
    // An id outliving its object is normal (a creep named in Memory whose body
    // was destroyed), so a cross-tick cache would serve a stale reference.
    engine = installFakeEngine();
    engine.addObject('c1', { id: 'c1' });
    objectById('c1');
    expect(objectCacheSize()).toBe(1);

    engine.advanceTick();
    expect(objectCacheSize()).toBe(0);
  });

  it('caches a miss so an unresolvable id is only looked up once', () => {
    engine = installFakeEngine();
    expect(objectById('missing')).toBeNull();
    expect(objectCacheSize()).toBe(1);
  });
});
