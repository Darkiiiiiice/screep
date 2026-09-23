import { afterEach, describe, expect, it, vi } from 'vitest';
import { extensionTiles, extractorSite, labSite, linkSite, preservesApproaches, preservesConnectivity, spawnTile, terminalSite } from '../../src/domain/planning';
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

describe('approach guard (sealed-sink prevention)', () => {
  // 测试模型里 blocked 一律视为"需要贴身的结构"：walkable=!blocked, needsApproach=blocked
  const preds = (blocked: ReadonlySet<string>) => ({
    walkable: (x: number, y: number) => !blocked.has(`${x},${y}`),
    needs: (x: number, y: number) => blocked.has(`${x},${y}`),
  });

  it('rejects the last open approach to a neighbor structure', () => {
    // 结构 S 在 (10,10)，其 8 邻域只剩 (11,11) 可及；在 (11,11) 放置会封印 S。
    const blocked = new Set(['10,10', '9,9', '9,10', '9,11', '10,9', '10,11', '11,9', '11,10']);
    const { walkable, needs } = preds(blocked);
    expect(preservesApproaches({ x: 11, y: 11 }, walkable, needs)).toBe(false);
  });

  it('allows placement while any other approach stays open', () => {
    const blocked = new Set(['10,10', '9,9', '9,11', '10,9', '10,11', '11,9', '11,10']); // (9,10) 留作 S 的另一可及格
    const { walkable, needs } = preds(blocked);
    expect(preservesApproaches({ x: 11, y: 11 }, walkable, needs)).toBe(true);
  });

  it('rejects a candidate born with no walkable neighbour (born-sealed)', () => {
    // 候选格 8 邻域全是结构：放在这里等于出生即封印（build/repair 都无法贴身）。
    const blocked = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (dx || dy) blocked.add(`${20 + dx},${20 + dy}`);
    }
    const { walkable, needs } = preds(blocked);
    expect(preservesApproaches({ x: 20, y: 20 }, walkable, needs)).toBe(false);
  });

  it('treats filling the last ring tile around a structure as a seal', () => {
    // 线上现场还原：扩展 (23,20) 的 8 邻域里 7 格已是结构，只剩 (23,19)。
    const blocked = new Set(['23,20', '24,20', '24,19', '22,19', '22,20', '23,21', '24,21', '22,21']);
    const { walkable, needs } = preds(blocked);
    // 在最后一格 (23,19) 放置 -> (23,20) 的环全灭 -> 封印
    expect(preservesApproaches({ x: 23, y: 19 }, walkable, needs)).toBe(false);
    // 若 (22,19) 也未占，则 (23,19) 放置后 (23,20) 仍可从 (22,19) 贴身 -> 放行
    const open2 = preds(new Set([...blocked].filter(k => k !== '22,19')));
    expect(preservesApproaches({ x: 23, y: 19 }, open2.walkable, open2.needs)).toBe(true);
    // 远处的放置不受影响
    expect(preservesApproaches({ x: 30, y: 30 }, walkable, needs)).toBe(true);
  });

  it('ignores neighbours that need no approach (walls) even when ringed', () => {
    // 候选旁只有"不需要贴身"的格：不约束放置。
    const { walkable } = preds(new Set());
    const wallNeeds = () => false;
    expect(preservesApproaches({ x: 30, y: 30 }, walkable, wallNeeds)).toBe(true);
  });
});

describe('colony spawn placement', () => {
  const open = () => true;
  const controller = { x: 25, y: 25 };
  const sources = [{ x: 10, y: 10 }, { x: 40, y: 10 }];

  it('minimizes the worst Chebyshev leg to controller and sources, deterministically', () => {
    const tile = spawnTile(controller, sources, open, open);
    expect(tile).toEqual({ x: 25, y: 19 });
    expect(spawnTile(controller, sources, open, open)).toEqual(tile);
  });

  it('skips blocked tiles and takes the next best', () => {
    const blocked = (x: number, y: number) => !(x === 25 && y === 19);
    expect(spawnTile(controller, sources, blocked, blocked)).toEqual({ x: 25, y: 20 });
  });

  it('rejects corridor cut vertices and returns undefined when nothing is safe', () => {
    // Endless one-tile-wide column: every candidate severs the only route.
    const column = (x: number, y: number) => x === 12 && y >= 1 && y <= 49;
    expect(spawnTile({ x: 12, y: 25 }, [{ x: 12, y: 1 }], column, column)).toBeUndefined();
    expect(spawnTile(controller, sources, () => false, () => false)).toBeUndefined();
  });

  it('keeps the spawn off the controller doorstep ring', () => {
    const tile = spawnTile({ x: 12, y: 12 }, [{ x: 12, y: 12 }], open, open);
    expect(tile).toBeDefined();
    expect(Math.max(Math.abs(tile!.x - 12), Math.abs(tile!.y - 12))).toBe(2);
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
  inRangeTo(target: Position, range: number) { return Math.max(Math.abs(this.x - target.x), Math.abs(this.y - target.y)) <= range; }
  lookFor(type: string) { return type === 'terrain' ? [wallMask[`${this.x}:${this.y}`] ? 'wall' : 'plain'] : []; }
}

function engineStub({ level, extensions = 0, sites = [] as unknown[], walls = {} as Record<string, true>, spawnFree = 10 }: { level: number; extensions?: number; sites?: unknown[]; walls?: Record<string, true>; spawnFree?: number }) {
  wallMask = walls;
  const spawn = { id: 'spawn-id', structureType: 'spawn', pos: new Position(25, 25), store: { getFreeCapacity: () => spawnFree } };
  const owned = Array.from({ length: extensions }, (_, i) => ({ id: `ext-${i}`, structureType: 'extension', pos: new Position(20 + i, 20), store: { getFreeCapacity: () => 0 } }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 形参为 mock.calls 断言提供元组类型
  const createConstructionSite = vi.fn((_x: number, _y: number, _type: string) => 0);
  vi.stubGlobal('Game', { time: 1000, creeps: {} });
  vi.stubGlobal('RoomPosition', Position);
  vi.stubGlobal('Memory', {});
  vi.stubGlobal('RESOURCE_ENERGY', 'energy');
  vi.stubGlobal('STRUCTURE_SPAWN', 'spawn');
  vi.stubGlobal('STRUCTURE_EXTENSION', 'extension');
  vi.stubGlobal('STRUCTURE_CONTAINER', 'container');
  vi.stubGlobal('STRUCTURE_ROAD', 'road');
  vi.stubGlobal('STRUCTURE_RAMPART', 'rampart');
  vi.stubGlobal('STRUCTURE_WALL', 'constructedWall');
  vi.stubGlobal('STRUCTURE_LINK', 'link');
  vi.stubGlobal('STRUCTURE_TERMINAL', 'terminal');
  vi.stubGlobal('STRUCTURE_EXTRACTOR', 'extractor');
  vi.stubGlobal('STRUCTURE_FACTORY', 'factory');
  vi.stubGlobal('STRUCTURE_LAB', 'lab');
  vi.stubGlobal('FIND_MINERALS', 4);
  vi.stubGlobal('StructureExtractor', class {});
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
    link: { 5: 2, 6: 3 },
    terminal: { 6: 1 },
    extractor: { 6: 1 },
    lab: { 6: 3 },
  });
  const room = {
    name: 'W0N1',
    controller: { ticksToDowngrade: 20000, level },
    createConstructionSite,
    lookAt: () => [],
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

  it('places storage at RCL4 once the tower stage is underway', () => {
    // 分批施工链(logistics.ts):扩展满基线 5 → tower 落点/落成 → storage。
    // 放置是 RCL4 解锁的确定性契约;进度归引擎探针窗口(场景端末帧进度受
    // mock CPU 混沌摆布,见 scenario-worker 台账注释)。
    const towerSite = siteStub('tower-site', 'tower');
    const { room, createConstructionSite } = engineStub({ level: 4, extensions: 5, sites: [towerSite] });
    runLogistics(room as unknown as Room, [workerStub('w1', 0)] as unknown as Creep[], [], {});
    expect(createConstructionSite).toHaveBeenCalledTimes(1);
    expect(createConstructionSite.mock.calls[0]![2]).toBe('storage');
  });

  it('holds storage until extensions hit the base line and a tower exists', () => {
    // 塔未落:storage 不解锁(收入与防御先于缓存);扩展未满基线:先铺扩展。
    const rcl4NoTower = engineStub({ level: 4, extensions: 5 });
    runLogistics(rcl4NoTower.room as unknown as Room, [workerStub('w1', 0)] as unknown as Creep[], [], {});
    expect(rcl4NoTower.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(rcl4NoTower.createConstructionSite.mock.calls[0]![2]).toBe('tower');

    const rcl4FewExt = engineStub({ level: 4, extensions: 4 });
    runLogistics(rcl4FewExt.room as unknown as Room, [workerStub('w1', 0)] as unknown as Creep[], [], {});
    expect(rcl4FewExt.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(rcl4FewExt.createConstructionSite.mock.calls[0]![2]).toBe('extension');
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

describe('link placement (M6-3)', () => {
  const free = () => true;
  const src = (x: number, y: number) => ({ x, y });

  it('places the first link beside a container near its source', () => {
    const site = linkSite({
      sources: [src(20, 20)], containers: [src(21, 20)], capacity: 2, links: [], free,
    });
    expect(site).toBeDefined();
    expect(Math.max(Math.abs(site!.x - 20), Math.abs(site!.y - 20))).toBeLessThanOrEqual(2);
    expect(Math.max(Math.abs(site!.x - 21), Math.abs(site!.y - 20))).toBeLessThanOrEqual(1);
  });

  it('adds the hub next to storage before a second source link', () => {
    const base = { sources: [src(10, 10), src(40, 40)], containers: [src(11, 10), src(41, 40)], storage: src(25, 25), capacity: 3, free };
    const first = linkSite({ ...base, links: [] });
    expect(Math.max(Math.abs(first!.x - 10), Math.abs(first!.y - 10))).toBeLessThanOrEqual(2);
    const second = linkSite({ ...base, links: [first!] });
    expect(Math.max(Math.abs(second!.x - 25), Math.abs(second!.y - 25))).toBeLessThanOrEqual(2);
    const third = linkSite({ ...base, links: [first!, second!] });
    expect(Math.max(Math.abs(third!.x - 40), Math.abs(third!.y - 40))).toBeLessThanOrEqual(2);
  });

  it('respects the cap and occupied tiles', () => {
    expect(linkSite({ sources: [src(10, 10)], containers: [], capacity: 1, links: [src(10, 11)], free })).toBeUndefined();
    const blocked = linkSite({
      sources: [src(10, 10)], containers: [src(11, 10)], capacity: 2, links: [],
      free: (x, y) => !(x >= 8 && x <= 12 && y >= 8 && y <= 12),
    });
    expect(blocked).toBeUndefined();
  });
});

describe('terminal placement (M6-4)', () => {
  const free = (x: number, y: number) => !(x === 24 && y === 22);
  it('places beside storage, preferring the closest tile', () => {
    const site = terminalSite({ storage: { x: 24, y: 22 }, links: [], free });
    expect(site).toBeDefined();
    const cheb = Math.max(Math.abs(site!.x - 24), Math.abs(site!.y - 22));
    expect(cheb).toBeLessThanOrEqual(2);
    expect(site).toEqual({ x: 23, y: 21 });
  });
  it('avoids existing links and needs a storage anchor', () => {
    const blocked = (x: number, y: number) => !(x === 23 && y === 21);
    const site = terminalSite({ storage: { x: 24, y: 22 }, links: [{ x: 23, y: 21 }], free: blocked });
    expect(site).toBeDefined();
    expect(site).not.toEqual({ x: 23, y: 21 });
    expect(terminalSite({ storage: undefined, links: [], free })).toBeUndefined();
  });
});

describe('extractor placement (M6-4)', () => {
  it('sits on the mineral tile itself and skips covered deposits', () => {
    const site = extractorSite({ minerals: [{ x: 30, y: 20 }, { x: 10, y: 10 }], extractors: [] });
    expect(site).toEqual({ x: 10, y: 10 });
    const covered = extractorSite({ minerals: [{ x: 30, y: 20 }, { x: 10, y: 10 }], extractors: [{ x: 10, y: 10 }, { x: 30, y: 20 }] });
    expect(covered).toBeUndefined();
  });
});

describe('terminal/extractor stage in growth chain (M6-4)', () => {
  it('places the terminal beside storage once links are saturated at RCL6', () => {
    // 探针现场复刻:RCL6、storage/3 链在册、双源容器就位、塔+扩展工地在册
    // (链闸放行),工地占用 storage 周边部分候选格。
    const cap = { getFreeCapacity: () => 100, getUsedCapacity: () => 0 };
    const storageOwned = { id: 'st', structureType: 'storage', pos: new Position(24, 22), store: cap };
    const linkPos = [[15, 14], [23, 21], [35, 34]];
    const links = linkPos.map(([x, y], i) => ({ id: `l${i}`, structureType: 'link', pos: new Position(x as number, y as number), store: cap }));
    const towerSites = [siteStub('t1', 'tower'), siteStub('t2', 'tower')];
    const extSites = [[25, 27], [27, 25], [23, 24]].map((_, i) => siteStub(`e${i}`, 'extension'));
    const containersOwned = [{ id: 'c1', structureType: 'container', pos: new Position(16, 13), store: cap }, { id: 'c2', structureType: 'container', pos: new Position(36, 34), store: cap }];
    // stub 的 Position.isNearTo 硬编码 false;这里逐实例放行,表达"容器贴源"。
    for (const c of containersOwned) (c.pos as Position).isNearTo = () => true;
    const sources = [{ id: 's1', pos: new Position(15, 13) }, { id: 's2', pos: new Position(35, 34) }];
    const spawnOwned = { id: 'spawn-id', structureType: 'spawn', pos: new Position(25, 25), store: { getFreeCapacity: () => 10, getUsedCapacity: () => 0 } };
    const { room, createConstructionSite } = engineStub({ level: 6, extensions: 10, sites: [...towerSites, ...extSites] });
    (room as { find: (k: number) => unknown[] }).find = (kind: number) =>
      kind === 1 ? containersOwned : kind === 2 ? [spawnOwned, storageOwned, ...links] : kind === 3 ? [spawnOwned] : [...towerSites, ...extSites];
    runLogistics(room as unknown as Room, [workerStub('w1', 0)] as unknown as Creep[], sources as unknown as Source[], {});
    const calls = createConstructionSite.mock.calls.map(c => [c[0], c[1], c[2]]);
    const terminals = calls.filter(c => c[2] === 'terminal');
    expect(terminals.length).toBeGreaterThanOrEqual(1);
    const [x, y] = terminals[0]! as [number, number];
    expect(Math.max(Math.abs(x - 24), Math.abs(y - 22))).toBeLessThanOrEqual(2);
  });
});

describe('lab placement (M6-5)', () => {
  const free = () => true;
  it('clusters labs within two of every existing lab, near the terminal', () => {
    const first = labSite({ anchor: { x: 23, y: 23 }, labs: [], free });
    expect(first).toEqual({ x: 22, y: 22 });
    const second = labSite({ anchor: { x: 23, y: 23 }, labs: [first!], free });
    expect(Math.max(Math.abs(second!.x - first!.x), Math.abs(second!.y - first!.y))).toBeLessThanOrEqual(2);
    const third = labSite({ anchor: { x: 23, y: 23 }, labs: [first!, second!], free });
    for (const lab of [first!, second!]) {
      expect(Math.max(Math.abs(third!.x - lab.x), Math.abs(third!.y - lab.y))).toBeLessThanOrEqual(2);
    }
  });
  it('needs a terminal anchor', () => {
    expect(labSite({ anchor: undefined, labs: [], free })).toBeUndefined();
  });
});
