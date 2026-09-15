import { afterEach, describe, expect, it, vi } from 'vitest';
import { extensionTiles, preservesConnectivity } from '../../src/domain/planning';
import { runLogistics } from '../../src/game/logistics';

afterEach(() => vi.unstubAllGlobals());

describe('extension tile ring scan', () => {
  const allFree = () => true;

  it('never places adjacent to the origin and respects the count cap', () => {
    const tiles = extensionTiles({ x: 25, y: 25 }, allFree, 10);
    expect(tiles).toHaveLength(10);
    for (const tile of tiles) {
      expect(Math.max(Math.abs(tile.x - 25), Math.abs(tile.y - 25))).toBeGreaterThanOrEqual(2);
    }
    expect(extensionTiles({ x: 25, y: 25 }, allFree, 0)).toEqual([]);
  });

  it('grows by increasing ring and is deterministic across replays', () => {
    const first = extensionTiles({ x: 25, y: 25 }, allFree, 17);
    const second = extensionTiles({ x: 25, y: 25 }, allFree, 17);
    expect(first).toEqual(second);
    // The full range-2 ring has 16 tiles; the 17th must come from range 3.
    expect(first.slice(0, 16).every(t => Math.max(Math.abs(t.x - 25), Math.abs(t.y - 25)) === 2)).toBe(true);
    expect(Math.max(Math.abs(first[16]!.x - 25), Math.abs(first[16]!.y - 25))).toBe(3);
  });
  it('skips blocked tiles and stays inside the buildable margin', () => {
    const blocked: Record<string, true> = { '23:25': true, '24:25': true };
    const tiles = extensionTiles({ x: 25, y: 25 }, (x, y) => !blocked[`${x}:${y}`], 8);
    expect(tiles.some(t => blocked[`${t.x}:${t.y}`])).toBe(false);
    // 14 free tiles remain in the range-2 ring, but the request caps at 8.
    expect(tiles).toHaveLength(8);
    const corner = extensionTiles({ x: 3, y: 3 }, allFree, 48);
    expect(corner.every(t => t.x >= 2 && t.y >= 2)).toBe(true);
  });
});

describe('connectivity guard', () => {
  const mask = (open: (x: number, y: number) => boolean) => open;

  it('keeps candidates in open ground', () => {
    expect(preservesConnectivity({ x: 25, y: 25 }, mask(() => true))).toBe(true);
  });

  it('rejects the middle of a one-tile-wide corridor between two areas', () => {
    // Open 5x5 areas at y 10..14 and y 18..22 joined only by the column x=12, y 15..17.
    const open = mask((x, y) =>
      (x >= 10 && x <= 14 && y >= 10 && y <= 14)
      || (x === 12 && y >= 15 && y <= 17)
      || (x >= 10 && x <= 14 && y >= 18 && y <= 22));
    expect(preservesConnectivity({ x: 12, y: 16 }, open)).toBe(false);
    // The corridor mouth tiles at the area boundary are still cut vertices.
    expect(preservesConnectivity({ x: 12, y: 15 }, open)).toBe(false);
    // A tile inside either open area connects nothing critical.
    expect(preservesConnectivity({ x: 11, y: 11 }, open)).toBe(true);
  });

  it('allows a dead-end leaf whose removal strands nothing', () => {
    const open = mask((x, y) => (x === 20 && y === 20) || (x === 21 && y === 20) || (x === 22 && y === 20));
    expect(preservesConnectivity({ x: 22, y: 20 }, open)).toBe(true);
    expect(preservesConnectivity({ x: 21, y: 20 }, open)).toBe(false);
  });
});

let wallMask: Record<string, true> = {};

class Position {
  roomName = 'W0N1';
  constructor(public x: number, public y: number) {}
  getRangeTo(target: Position) { return Math.abs(this.x - target.x) + Math.abs(this.y - target.y); }
  findClosestByRange<T>(list: T[]) { return list[0]; }
  isEqualTo(target: Position) { return this.x === target.x && this.y === target.y; }
  isNearTo() { return false; }
  lookFor(type: string) { return type === 'terrain' ? [wallMask[`${this.x}:${this.y}`] ? 'wall' : 'plain'] : []; }
}

function engineStub({ level, extensions = 0, sites = [] as unknown[], walls = {} as Record<string, true>, spawnFree = 10 }: { level: number; extensions?: number; sites?: unknown[]; walls?: Record<string, true>; spawnFree?: number }) {
  wallMask = walls;
  const spawn = { id: 'spawn-id', structureType: 'spawn', pos: new Position(25, 25), store: { getFreeCapacity: () => spawnFree } };
  const owned = Array.from({ length: extensions }, (_, i) => ({ id: `ext-${i}`, structureType: 'extension', pos: new Position(20 + i, 20), store: { getFreeCapacity: () => 0 } }));
  const createConstructionSite = vi.fn((_x: number, _y: number, _type: string) => 0);
  vi.stubGlobal('Game', { time: 1000, creeps: {} });
  vi.stubGlobal('RoomPosition', Position);
  vi.stubGlobal('Memory', {});
  vi.stubGlobal('RESOURCE_ENERGY', 'energy');
  vi.stubGlobal('STRUCTURE_SPAWN', 'spawn');
  vi.stubGlobal('STRUCTURE_EXTENSION', 'extension');
  vi.stubGlobal('STRUCTURE_CONTAINER', 'container');
  vi.stubGlobal('STRUCTURE_TOWER', 'tower');
  vi.stubGlobal('STRUCTURE_STORAGE', 'storage');
  vi.stubGlobal('FIND_STRUCTURES', 1);
  vi.stubGlobal('FIND_MY_STRUCTURES', 2);
  vi.stubGlobal('FIND_MY_SPAWNS', 3);
  vi.stubGlobal('FIND_MY_CONSTRUCTION_SITES', 4);
  vi.stubGlobal('ERR_NOT_IN_RANGE', -9);
  vi.stubGlobal('WORK', 'work');
  vi.stubGlobal('OK', 0);
  vi.stubGlobal('LOOK_TERRAIN', 'terrain');
  vi.stubGlobal('LOOK_STRUCTURES', 'structure');
  vi.stubGlobal('LOOK_CONSTRUCTION_SITES', 'constructionSite');
  vi.stubGlobal('CONTROLLER_STRUCTURES', {
    extension: { 1: 0, 2: 5, 3: 10, 4: 20 },
    container: { 1: 5, 2: 5, 3: 5, 4: 5 },
    tower: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2 },
    storage: { 1: 0, 2: 0, 3: 0, 4: 1 },
  });
  const room = {
    name: 'W0N1',
    controller: { ticksToDowngrade: 20000, level },
    createConstructionSite,
    find: (kind: number) =>
      kind === 1 ? [] : kind === 2 ? [spawn, ...owned] : kind === 3 ? [spawn] : sites,
  };
  return { room, createConstructionSite };
}

const workerStub = (name: string, energy: number) => ({
  name, spawning: false, memory: {} as Record<string, unknown>,
  store: { energy, getUsedCapacity: () => energy, getFreeCapacity: () => 50 - energy },
  pos: new Position(16, 16), getActiveBodyparts: () => 1,
  repair: vi.fn(() => 0), withdraw: vi.fn(() => 0), harvest: vi.fn(() => 0), transfer: vi.fn(() => 0), build: vi.fn(() => 0),
});

const siteStub = (id: string, type: string) => ({ id, structureType: type, pos: new Position(20, 20), progress: 0, progressTotal: 1000 });

describe('extension placement and construction', () => {
  it('places nothing at RCL1 and one site per tick at RCL2', () => {
    const rcl1 = engineStub({ level: 1 });
    runLogistics(rcl1.room as unknown as Room, [workerStub('w1', 0)] as unknown as Creep[], [], {});
    expect(rcl1.createConstructionSite).not.toHaveBeenCalled();

    const rcl2 = engineStub({ level: 2 });
    runLogistics(rcl2.room as unknown as Room, [workerStub('w1', 0)] as unknown as Creep[], [], {});
    expect(rcl2.createConstructionSite).toHaveBeenCalledTimes(1);
    const [x, y, type] = rcl2.createConstructionSite.mock.calls[0]!;
    expect(type).toBe('extension');
    expect(Math.max(Math.abs(x - 25), Math.abs(y - 25))).toBeGreaterThanOrEqual(2);
  });

  it('stops placing once owned extensions reach the controller cap', () => {
    const { room, createConstructionSite } = engineStub({ level: 2, extensions: 5 });
    runLogistics(room as unknown as Room, [workerStub('w1', 0)] as unknown as Creep[], [], {});
    expect(createConstructionSite).not.toHaveBeenCalled();
  });

  it('builds an extension site from the dedicated slot above the worker floor', () => {
    // Extension construction is gated on the controller's structure cap (RCL2)
    // and claims the one builder slot above the two-worker economy floor, before
    // hauling: the slot is a first-class labor position, not idle-luck surplus.
    const site = siteStub('ext-site', 'extension');
    const { room } = engineStub({ level: 2, sites: [site] });
    const sources = [{ id: 's1', pos: new Position(5, 5), energy: 3000 }, { id: 's2', pos: new Position(45, 45), energy: 3000 }];
    const workers = [workerStub('w1', 50), workerStub('w2', 0), workerStub('w3', 0), workerStub('w4', 0)];
    runLogistics(room as unknown as Room, workers as unknown as Creep[], sources as unknown as Source[], {});
    expect(workers[0]!.build).toHaveBeenCalledExactlyOnceWith(site); // carrying builder builds immediately
  });

  it('a carrying surplus worker builds immediately when no sink demands energy', () => {
    const site = siteStub('ext-site', 'extension');
    // Spawn store is full: the haul loop has no demand, so a carrying worker is
    // genuine surplus and builds without a detour through harvesting.
    const { room } = engineStub({ level: 2, sites: [site], spawnFree: 0 });
    const workers = [workerStub('w1', 50), workerStub('w2', 0), workerStub('w3', 0), workerStub('w4', 0)];
    runLogistics(room as unknown as Room, workers as unknown as Creep[], [], {});
    expect(workers[0]!.memory.containerSite).toBe('ext-site');
    expect(workers[0]!.build).toHaveBeenCalledExactlyOnceWith(site);
  });

  it('assigns builders to container sites before extension sites', () => {
    const container = siteStub('container-site', 'container');
    const extension = siteStub('ext-site', 'extension');
    const { room } = engineStub({ level: 2, sites: [extension, container], spawnFree: 0 });
    const workers = [workerStub('w1', 0), workerStub('w2', 0), workerStub('w3', 0), workerStub('w4', 0), workerStub('w5', 0)];
    runLogistics(room as unknown as Room, workers as unknown as Creep[], [], {});
    expect(workers[0]!.memory.containerSite).toBe('container-site');
    expect(workers[1]!.memory.containerSite).toBe('ext-site');
  });

  it('skips a ring tile that seals a pocket and places on the next open tile', () => {
    // Pocket interior west of the spawn ring: tiles (22,24..26) enclosed by walls,
    // with (23,25) — the first ring candidate — as the only entrance.
    const walls: Record<string, true> = {
      '21:23': true, '21:24': true, '21:25': true, '21:26': true, '21:27': true,
      '22:23': true, '22:27': true,
      '23:23': true, '23:24': true, '23:26': true, '23:27': true,
    };
    expect(preservesConnectivity({ x: 23, y: 25 }, (x, y) => x >= 0 && x < 50 && y >= 0 && y < 50 && !walls[`${x}:${y}`])).toBe(false);
    const { room, createConstructionSite } = engineStub({ level: 2, walls });
    runLogistics(room as unknown as Room, [workerStub('w1', 0)] as unknown as Creep[], [], {});
    expect(createConstructionSite).toHaveBeenCalledTimes(1);
    const [x, y] = createConstructionSite.mock.calls[0]!;
    expect([x, y]).not.toEqual([23, 25]);
    expect(Math.max(Math.abs(x - 25), Math.abs(y - 25))).toBeGreaterThanOrEqual(2);
  });
});
