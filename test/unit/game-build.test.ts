import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { placeWanted, spawnReachesSource } from '@/game/build';
import type { RoomView } from '@/domain/types';

// The engine injects these as globals; the module reads them at call time.
let engine: FakeEngine | undefined;

beforeEach(() => {
  engine = installFakeEngine();
  Object.assign(globalThis, {
    TERRAIN_MASK_WALL: 1,
    OK: 0,
    LOOK_STRUCTURES: 101,
    LOOK_CONSTRUCTION_SITES: 115,
    FIND_SOURCES: 105,
    FIND_MY_CONSTRUCTION_SITES: 113,
    FIND_MY_SPAWNS: 115,
  });
});

afterEach(() => {
  engine?.restore();
  engine = undefined;
});

/**
 * A room stub with an explicit wall layout.
 *
 * `spawnReachesSource` is the invariant check that replaced a geometric "keep the
 * spawn's neighbours clear" rule, so its tests are about room LAYOUTS rather than
 * about coordinates: the whole point is that no fixed set of coordinates is a
 * correct answer.
 */
interface Stub {
  room: Room;
  spawn: StructureSpawn;
}

function room(parts: {
  walls?: string[];
  spawn: [number, number];
  sources: [number, number][];
  blocked?: string[];
}): Stub {
  const walls = new Set(parts.walls ?? []);
  const blocked = new Set(parts.blocked ?? []);

  const terrain = {
    get: (x: number, y: number) => (walls.has(`${String(x)},${String(y)}`) ? TERRAIN_MASK_WALL : 0),
  };

  // Declared before `find` uses it; the factory previously had this below.
  const spawnObj = {
    pos: { x: parts.spawn[0], y: parts.spawn[1] },
    structureType: 'spawn',
  };

  const sites = [...blocked].map((k) => {
    const [x, y] = k.split(',').map(Number) as [number, number];
    return { pos: { x, y } };
  });

  const find = (t: number): unknown[] => {
    if (t === FIND_SOURCES) {
      return parts.sources.map(([x, y]) => ({ id: `s${String(x)}${String(y)}`, pos: { x, y } }));
    }
    if (t === FIND_MY_CONSTRUCTION_SITES) return sites;
    if (t === FIND_MY_SPAWNS) return [spawnObj];
    return [];
  };

  const created: { x: number; y: number; structureType: string }[] = [];

  const stub = {
    name: 'W1N1',
    getTerrain: () => terrain,
    find,
    created,
    createConstructionSite: (x: number, y: number, structureType: string) => {
      created.push({ x, y, structureType });
      return 0; // OK
    },
    // `LOOK_*` are string constants in the engine API, unlike the numeric
    // `FIND_*` selectors.
    lookForAt: (lookType: string, x: number, y: number) => {
      if (lookType === LOOK_CONSTRUCTION_SITES) {
        return sites.filter((s) => s.pos.x === x && s.pos.y === y);
      }
      // No structures exist in these layouts; walls come from terrain instead.
      return [];
    },
  };

  return { room: stub as unknown as Room, spawn: spawnObj as unknown as StructureSpawn };
}

describe('spawnReachesSource', () => {
  it('is satisfied on an open map', () => {
    const { room: r, spawn } = room({ spawn: [25, 25], sources: [[25, 20]] });
    expect(spawnReachesSource(r, spawn, [])).toBe(true);
  });

  it('is satisfied when a terrain wall lies between, as long as a route exists', () => {
    const walls = [];
    // A straight wall with a gap at x=23.
    for (let x = 20; x <= 30; x += 1) {
      if (x === 23) continue;
      walls.push(`${String(x)},22`);
    }
    const { room: r, spawn } = room({ walls, spawn: [25, 25], sources: [[25, 20]] });
    expect(spawnReachesSource(r, spawn, [])).toBe(true);
  });

  it('fails when a wall seals the source off completely', () => {
    // The wall spans the full width. A partial wall would be walked around, and
    // an earlier version of this test made exactly that mistake — the search
    // correctly went round the end and the test blamed the code.
    const walls = [];
    for (let x = 1; x <= 48; x += 1) walls.push(`${String(x)},22`);
    const { room: r, spawn } = room({ walls, spawn: [25, 25], sources: [[25, 20]] });
    expect(spawnReachesSource(r, spawn, [])).toBe(false);
  });

  it('fails when a candidate placement would complete a seal', () => {
    // This is the case the geometric rule missed. Blocking two tiles at distance
    // 2 can seal a corridor while every neighbour of the spawn stays clear —
    // measured live as a loaded harvester bouncing between two tiles forever.
    const walls = [];
    for (let x = 1; x <= 48; x += 1) {
      if (x === 25) continue; // the one gap
      walls.push(`${String(x)},22`);
    }
    const { room: r, spawn } = room({ walls, spawn: [25, 25], sources: [[25, 20]] });

    // Open while the gap at (25,22) is free.
    expect(spawnReachesSource(r, spawn, [])).toBe(true);

    // Sealed by placing one structure in that gap. Note the placement is at
    // distance 3 from the spawn, nowhere near its neighbours — which is exactly
    // why a rule about neighbouring tiles cannot answer this question.
    expect(spawnReachesSource(r, spawn, ['25,22'])).toBe(false);
  });

  it('is unaffected by a placement that leaves a route open', () => {
    const { room: r, spawn } = room({ spawn: [25, 25], sources: [[25, 20]] });
    // A far-away tile costs nothing.
    expect(spawnReachesSource(r, spawn, ['10,10'])).toBe(true);
  });

  it('passes trivially when the room has no source', () => {
    // Nothing to connect to, so nothing to protect.
    const { room: r, spawn } = room({ spawn: [25, 25], sources: [] });
    expect(spawnReachesSource(r, spawn, [])).toBe(true);
  });

  it('treats an existing construction site as an obstacle', () => {
    // Sites block pathfinding exactly as built structures do, so a check that
    // ignored them would approve a layout creeps cannot actually walk.
    const walls = [];
    for (let x = 1; x <= 48; x += 1) {
      if (x === 25) continue;
      walls.push(`${String(x)},22`);
    }
    const { room: r, spawn } = room({
      walls,
      spawn: [25, 25],
      sources: [[25, 20]],
      blocked: ['25,22'],
    });
    expect(spawnReachesSource(r, spawn, [])).toBe(false);
  });
});


describe('placement anchor', () => {
  /**
   * The bug this pins, found by measuring the live room: containers were placed
   * beside the SPAWN — four and six tiles from the nearest source. A container
   * exists to buffer energy at the mining site, so one away from the source
   * leaves the harvester walking the full round trip and buys nothing. The
   * throughput estimate that justified building it assumed adjacency.
   *
   * These drive `placeWanted`, not `findSpots`, because the defect was in the
   * CHOICE of anchor. Calling `findSpots` with a source anchor directly would
   * assert the primitive and never touch the decision that was wrong.
   */
  function placedSites(r: Room): { x: number; y: number; structureType: string }[] {
    return (r as unknown as { created: { x: number; y: number; structureType: string }[] }).created;
  }

  it('puts a container beside a source, not beside the spawn', () => {
    const { room: r } = room({ spawn: [25, 25], sources: [[25, 20]] });

    placeWanted(r, [{ structureType: 'container', missing: 1, ceiling: 2 }], {
      name: 'W1N1',
    } as RoomView);

    const placed = placedSites(r).filter((c) => c.structureType === 'container');
    expect(placed.length).toBeGreaterThan(0);

    for (const c of placed) {
      const dSource = Math.max(Math.abs(c.x - 25), Math.abs(c.y - 20));
      expect(dSource, `container at (${String(c.x)},${String(c.y)})`).toBeLessThanOrEqual(2);
    }
  });

  it('keeps extensions beside the spawn, where delivery distance is what counts', () => {
    const { room: r } = room({ spawn: [25, 25], sources: [[10, 10]] });

    placeWanted(r, [{ structureType: 'extension', missing: 3, ceiling: 5 }], {
      name: 'W1N1',
    } as RoomView);

    const placed = placedSites(r).filter((c) => c.structureType === 'extension');
    expect(placed.length).toBe(3);

    for (const c of placed) {
      const dSpawn = Math.max(Math.abs(c.x - 25), Math.abs(c.y - 25));
      expect(dSpawn, `extension at (${String(c.x)},${String(c.y)})`).toBeLessThanOrEqual(4);
    }
  });

  it('spreads containers across sources instead of stacking them', () => {
    // Both containers beside one source leaves the other source unbuffered,
    // which is the situation containers exist to fix.
    const { room: r } = room({
      spawn: [25, 25],
      sources: [
        [10, 10],
        [40, 40],
      ],
    });

    placeWanted(r, [{ structureType: 'container', missing: 2, ceiling: 2 }], {
      name: 'W1N1',
    } as RoomView);

    const placed = placedSites(r).filter((c) => c.structureType === 'container');
    expect(placed.length).toBe(2);

    const nearFirst = placed.filter((c) => Math.max(Math.abs(c.x - 10), Math.abs(c.y - 10)) <= 2);
    const nearSecond = placed.filter((c) => Math.max(Math.abs(c.x - 40), Math.abs(c.y - 40)) <= 2);
    expect(nearFirst.length).toBe(1);
    expect(nearSecond.length).toBe(1);
  });

  it('refuses a container that would seal the spawn in', () => {
    // Connectivity outranks placement: a container that blocks the only route
    // costs the whole economy, not just its own 250 energy.
    const walls: string[] = [];
    for (let x = 1; x <= 48; x += 1) {
      if (x === 25) continue;
      walls.push(`${String(x)},22`);
    }
    // Only a tile reachable at the source, but the gap is what keeps it alive.
    const { room: r } = room({ walls, spawn: [25, 25], sources: [[25, 20]] });

    placeWanted(r, [{ structureType: 'container', missing: 1, ceiling: 2 }], {
      name: 'W1N1',
    } as RoomView);

    const placed = placedSites(r).filter((c) => c.structureType === 'container');
    // Whether or not a legal tile exists, the room must stay connected.
    const spawn = { pos: { x: 25, y: 25 } } as StructureSpawn;
    const blocked = placed.map((c) => `${String(c.x)},${String(c.y)}`);
    expect(spawnReachesSource(r, spawn, blocked)).toBe(true);
  });
});
