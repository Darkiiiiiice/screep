import { describe, expect, it } from 'vitest';
import { structureWants } from '@/domain/build';
import type { ConstructionSiteView, RoomView, StoreView } from '@/domain/types';

function room(opts: {
  level: number;
  stores?: StoreView[];
  sites?: ConstructionSiteView[];
}): RoomView {
  return {
    name: 'W1N1',
    controller: {
      id: 'ctrl',
      x: 43,
      y: 17,
      level: opts.level,
      my: true,
      ticksToDowngrade: 20_000,
      progress: 0,
      progressTotal: 45_000,
    },
    spawns: [],
    sources: [],
    stores: opts.stores ?? [],
    constructionSites: opts.sites ?? [],
    creeps: [],
    hostiles: [],
  };
}

function structure(type: string, i = 1): StoreView {
  return {
    id: `${type}${String(i)}`,
    type,
    x: 10 + i,
    y: 10,
    room: 'W1N1',
    energy: 0,
    energyCapacity: 50,
  };
}

function site(structureType: string, i = 1): ConstructionSiteView {
  return {
    id: `site${String(i)}`,
    x: 20 + i,
    y: 20,
    room: 'W1N1',
    structureType,
    progress: 0,
    progressTotal: 100,
  };
}

describe('structureWants', () => {
  it('wants nothing below RCL 2, where no structures are unlocked', () => {
    // RCL 1 permits only roads and containers; neither is worth energy yet.
    expect(structureWants(room({ level: 1 }))).toEqual([]);
    expect(structureWants(room({ level: 0 }))).toEqual([]);
  });

  const want = (level: number, type: string, stores: StoreView[] = [], sites: ConstructionSiteView[] = []) =>
    structureWants(room({ level, stores, sites })).find((w) => w.structureType === type);

  it('wants extensions and containers once RCL 2 unlocks them', () => {
    // Both are in the table from RCL 2. Containers are deferred here rather than
    // offered from RCL 0 because their 250 energy competes with the 200 that
    // unlocks the first extensions — and the extensions come first.
    expect(want(2, 'extension')?.ceiling).toBe(5);
    expect(want(2, 'container')?.ceiling).toBe(2);
  });

  it('counts existing structures toward the ceiling', () => {
    const built = [1, 2].map((i) => structure('extension', i));
    expect(want(2, 'extension', built)?.missing).toBe(2);
  });

  it('counts sites under construction toward the ceiling', () => {
    // Without this the colony queues a duplicate site for everything it has
    // already started, and wastes its builders on redundant foundations.
    const one = [structure('extension', 1)];
    const sites = [site('extension', 1), site('extension', 2)];
    const w = want(2, 'extension', one, sites);

    // 1 built + 2 sites = 3 of 5.
    expect(w?.missing).toBe(2);
  });

  it('queues at most two sites per tick', () => {
    // Committing one spawn's worth of energy to construction at once would stall
    // the extensions the energy was meant to fill.
    expect(want(2, 'extension')?.missing).toBe(2);
  });

  it('wants nothing once every ceiling is reached', () => {
    // Extensions AND containers must both be satisfied; filling only the first
    // leaves the container want outstanding, which is correct rather than a bug.
    const stores = [
      ...[1, 2, 3, 4, 5].map((i) => structure('extension', i)),
      ...[1, 2].map((i) => structure('container', i)),
    ];
    expect(structureWants(room({ level: 2, stores }))).toEqual([]);

    // Extensions alone still leaves the containers wanting.
    const partial = [1, 2, 3, 4, 5].map((i) => structure('extension', i));
    expect(structureWants(room({ level: 2, stores: partial }))).toHaveLength(1);
  });

  it('treats the official table as cumulative, not incremental', () => {
    // RCL 3 permits 10 extensions in total, so with 5 built it wants 5 more —
    // not 10. Reading the table as an increment would over-build.
    const five = [1, 2, 3, 4, 5].map((i) => structure('extension', i));

    expect(want(3, 'extension', five)?.ceiling).toBe(10);
    expect(want(3, 'extension', five)?.missing).toBe(2); // capped per tick
    expect(want(3, 'tower')?.ceiling).toBe(1);
  });

  it('adds storage at RCL 4', () => {
    expect(want(4, 'storage')).toBeDefined();
  });

  it('does not want structures the colony cannot yet use', () => {
    // Towers and storage are combat and long-term concerns; requesting them at
    // RCL 2 would spend the only spawn's energy on the wrong thing.
    expect(structureWants(room({ level: 2 })).map((w) => w.structureType).sort()).toEqual([
      'container',
      'extension',
    ]);
  });
});
