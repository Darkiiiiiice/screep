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

  it('wants extensions once RCL 2 unlocks them', () => {
    // RCL 2 is the first level that raises energy capacity, and capacity is what
    // caps how much energy the room can convert per trip.
    const wants = structureWants(room({ level: 2 }));
    expect(wants).toEqual([{ structureType: 'extension', missing: 2, ceiling: 5 }]);
  });

  it('counts existing structures toward the ceiling', () => {
    const wants = structureWants(
      room({ level: 2, stores: [structure('extension', 1), structure('extension', 2)] }),
    );
    expect(wants).toEqual([{ structureType: 'extension', missing: 2, ceiling: 5 }]);
  });

  it('counts sites under construction toward the ceiling', () => {
    // Without this the colony queues a duplicate site for everything it has
    // already started, and wastes its builders on redundant foundations.
    const wants = structureWants(
      room({
        level: 2,
        stores: [structure('extension', 1)],
        sites: [site('extension', 1), site('extension', 2)],
      }),
    );
    expect(wants).toEqual([{ structureType: 'extension', missing: 2, ceiling: 5 }]);
  });

  it('queues at most two sites per tick', () => {
    // Committing one spawn's worth of energy to construction at once would stall
    // the extensions the energy was meant to fill.
    const wants = structureWants(room({ level: 2 }));
    expect(wants[0]?.missing).toBe(2);
  });

  it('wants nothing once the ceiling is reached', () => {
    const full = [1, 2, 3, 4, 5].map((i) => structure('extension', i));
    expect(structureWants(room({ level: 2, stores: full }))).toEqual([]);
  });

  it('treats the official table as cumulative, not incremental', () => {
    // RCL 3 permits 10 extensions in total, so with 5 built it wants 5 more —
    // not 10. Reading the table as an increment would over-build.
    const five = [1, 2, 3, 4, 5].map((i) => structure('extension', i));
    const wants = structureWants(room({ level: 3, stores: five }));

    const extensions = wants.find((w) => w.structureType === 'extension');
    expect(extensions?.ceiling).toBe(10);
    expect(extensions?.missing).toBe(2); // capped by MAX_SITES_PER_TICK

    const tower = wants.find((w) => w.structureType === 'tower');
    expect(tower?.ceiling).toBe(1);
    expect(tower?.missing).toBe(1);
  });

  it('adds storage at RCL 4', () => {
    const wants = structureWants(room({ level: 4 }));
    expect(wants.some((w) => w.structureType === 'storage')).toBe(true);
  });

  it('does not want structures the colony cannot yet use', () => {
    // Towers and storage are combat/long-term concerns; requesting them at RCL 2
    // would spend the only spawn's energy on the wrong thing.
    const wants = structureWants(room({ level: 2 }));
    expect(wants.map((w) => w.structureType)).toEqual(['extension']);
  });
});
