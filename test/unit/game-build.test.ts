import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { spawnReachesSource } from '@/game/build';

// The engine injects these as globals; the module reads them at call time.
let engine: FakeEngine | undefined;

beforeEach(() => {
  engine = installFakeEngine();
  Object.assign(globalThis, {
    TERRAIN_MASK_WALL: 1,
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

  const sites = [...blocked].map((k) => {
    const [x, y] = k.split(',').map(Number) as [number, number];
    return { pos: { x, y } };
  });

  const find = (t: number): unknown[] => {
    if (t === FIND_SOURCES) {
      return parts.sources.map(([x, y]) => ({ id: `s${String(x)}${String(y)}`, pos: { x, y } }));
    }
    if (t === FIND_MY_CONSTRUCTION_SITES) return [];
    if (t === FIND_MY_SPAWNS) return [];
    return [];
  };

  const stub = {
    name: 'W1N1',
    getTerrain: () => terrain,
    find,
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

  const spawn = { pos: { x: parts.spawn[0], y: parts.spawn[1] } } as StructureSpawn;
  return { room: stub as unknown as Room, spawn };
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
