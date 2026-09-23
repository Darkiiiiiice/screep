import { afterEach, describe, expect, it, vi } from 'vitest';
import { upgradeDutyQuota, LogisticsBoard, STORAGE_RESERVE_FLOOR, refuelTargets } from '../../src/domain/logistics';
import { runLogistics } from '../../src/game/logistics';

afterEach(() => vi.unstubAllGlobals());

describe('storage reserve floor (M6-1)', () => {
  const stock = (id: string, energy: number, storage = false) => ({ id, energy, storage });

  it('hides storage at or below the floor from industry, keeps containers', () => {
    const targets = refuelTargets([stock('c1', 10), stock('s1', STORAGE_RESERVE_FLOOR, true), stock('s2', STORAGE_RESERVE_FLOOR + 1, true)]);
    expect(targets.map(t => t.id)).toEqual(['c1', 's2']);
    expect(refuelTargets([stock('s1', 0, true)])).toEqual([]);
  });

  it('supports a custom floor', () => {
    expect(refuelTargets([stock('s1', 150, true)], 150).map(t => t.id)).toEqual([]);
    expect(refuelTargets([stock('s1', 151, true)], 150).map(t => t.id)).toEqual(['s1']);
  });
});

it('releases both reservations exactly once when a worker abandons its order', () => {
  const board = new LogisticsBoard([{ id: 'mine', amount: 50 }], [{ id: 'spawn', amount: 50, priority: 10 }]);
  board.reserve('blocked', 50, ['mine']);
  board.release('blocked');
  board.release('blocked');
  expect(board.reserve('replacement', 100, ['mine'])?.amount).toBe(50);
  expect(board.reserve('extra', 50, ['mine'])).toBeUndefined();
});

it('reconciles a retained destination against shrinking capacity and target loss', () => {
  const board = new LogisticsBoard([{ id: 'mine', amount: 100 }], [{ id: 'spawn', amount: 10, priority: 10 }]);
  expect(board.reserve('a', 50, ['mine'], 'gone')).toBeUndefined();
  expect(board.reserve('a', 50, ['mine'], 'spawn')?.amount).toBe(10);
});

it('reserves finite supply and destination space once per worker', () => {
  const board = new LogisticsBoard([{ id: 'mine', amount: 80 }], [{ id: 'spawn', amount: 60, priority: 10 }]);
  expect(board.reserve('a', 50, ['mine'])?.amount).toBe(50);
  expect(board.reserve('a', 50, ['mine'])?.amount).toBe(50);
  expect(board.reserve('b', 50, ['mine'])?.amount).toBe(10);
  expect(board.reserve('c', 50, ['mine'])).toBeUndefined();
});
it('prioritizes emergency delivery and rejects self-transfer cycles', () => {
  const board = new LogisticsBoard([{ id: 'mine', amount: 100 }], [{ id: 'mine', amount: 100, priority: 100 }, { id: 'upgrade', amount: 100, priority: 1 }, { id: 'spawn', amount: 25, priority: 10 }]);
  expect(board.reserve('a', 50, ['mine'])?.to).toBe('spawn');
  expect(board.reserve('b', 50, ['mine'])?.to).toBe('upgrade');
});
it('rebuilding after death or target loss frees reservations against current observations', () => {
  const old = new LogisticsBoard([{ id: 'mine', amount: 50 }], [{ id: 'spawn', amount: 50, priority: 10 }]);
  old.reserve('dead', 50, ['mine']);
  const current = new LogisticsBoard([{ id: 'mine', amount: 20 }], [{ id: 'replacement', amount: 30, priority: 10 }]);
  expect(current.reserve('alive', 50, ['mine'])).toEqual({ worker: 'alive', from: 'mine', to: 'replacement', amount: 20 });
});

it('keeps per-room task memory isolated when sibling rooms run on shared memory', () => {
  class Position {
    roomName: string;
    constructor(public x: number, public y: number, room: string) { this.roomName = room; }
    getRangeTo() { return 5; }
    isNearTo() { return false; }
    findClosestByRange() { return undefined; }
  }
  vi.stubGlobal('Game', { time: 5000, creeps: {} });
  vi.stubGlobal('RoomPosition', Position);
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
  vi.stubGlobal('FIND_MY_STRUCTURES', 1);
  vi.stubGlobal('FIND_MY_SPAWNS', 2);
  vi.stubGlobal('FIND_MY_CONSTRUCTION_SITES', 3);
  vi.stubGlobal('FIND_STRUCTURES', 4);
  vi.stubGlobal('CONTROLLER_STRUCTURES', { extension: { 0: 0, 1: 0, 2: 5 } });
  const memory: { logisticsTasks?: Record<string, Record<string, unknown>> } = {};
  vi.stubGlobal('Memory', memory);
  const creep = (name: string) => ({
    name, spawning: false,
    memory: { shipment: { from: 'container', to: 'spawn-id', expires: 5200, waitingSince: 4990 } },
    store: { energy: 0, getUsedCapacity: () => 0, getFreeCapacity: () => 50 },
    pos: new Position(25, 25, name.endsWith('a') ? 'W0N1' : 'W0N2'),
  });
  const room = (name: string) => ({
    name,
    controller: { ticksToDowngrade: 20000 },
    createConstructionSite: () => 0,
    lookAt: () => [],
    find: (type: number) => type === 1 ? [{ structureType: 'spawn', id: 'spawn-id', pos: new Position(25, 25, name), store: { getFreeCapacity: () => 10 } }] : type === 2 ? [{ id: 'spawn-id' }] : [],
  });
  runLogistics(room('W0N1') as unknown as Room, [creep('worker-a')] as unknown as Creep[], [], {});
  runLogistics(room('W0N2') as unknown as Room, [creep('worker-b')] as unknown as Creep[], [], {});
  expect(Object.keys(memory.logisticsTasks ?? {}).sort()).toEqual(['W0N1', 'W0N2']);
  expect(Object.keys(memory.logisticsTasks?.W0N1 ?? {})).toContain('haul:worker-a');
  expect(Object.keys(memory.logisticsTasks?.W0N2 ?? {})).toContain('haul:worker-b');
  // A sibling room's cleanup must not wipe the other room's starvation history.
  runLogistics(room('W0N1') as unknown as Room, [creep('worker-a')] as unknown as Creep[], [], {});
  expect(Object.keys(memory.logisticsTasks?.W0N2 ?? {})).toContain('haul:worker-b');
});

it('appoints an upgrader in the downgrade recovery band despite fresh crumb progress', () => {
  // Live bug 2026-09-17: bootstrap's urgent crumb shuttle kept controller
  // progress fresh, so the 200-tick stagnation trigger never fired and the
  // room hovered at the 3000 tripwire with upgrade throughput ~0.
  class Position {
    roomName: string;
    constructor(public x: number, public y: number, room: string) { this.roomName = room; }
    getRangeTo() { return 10; }
    isNearTo() { return false; }
    findClosestByRange() { return undefined; }
  }
  const now = 50000;
  vi.stubGlobal('Game', { time: now, creeps: {} });
  vi.stubGlobal('RoomPosition', Position);
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
  vi.stubGlobal('FIND_MY_STRUCTURES', 1);
  vi.stubGlobal('FIND_MY_SPAWNS', 2);
  vi.stubGlobal('FIND_MY_CONSTRUCTION_SITES', 3);
  vi.stubGlobal('FIND_STRUCTURES', 4);
  vi.stubGlobal('ERR_NOT_IN_RANGE', -10);
  vi.stubGlobal('CONTROLLER_STRUCTURES', { extension: { 3: 0 }, tower: { 3: 0 }, storage: { 3: 0 } });
  vi.stubGlobal('OK', 0);
  const memory: { controllerService?: Record<string, { progress: number; level: number; lastProgress: number; worker?: string }> } = {
    // Crumbs just refreshed the clock — but the timer is still in the band.
    controllerService: { W0N1: { progress: 100, level: 3, lastProgress: now - 10 } },
  };
  vi.stubGlobal('Memory', memory);
  const upgraded: string[] = [];
  const creep = (name: string, energy: number) => ({
    name, spawning: false, memory: {},
    store: { energy, getUsedCapacity: () => energy, getFreeCapacity: () => 50 - energy },
    pos: new Position(25, 25, 'W0N1'),
    upgradeController: () => { upgraded.push(name); return 0; },
    harvest: () => 0,
  });
  const creeps = [creep('worker-a', 10), creep('worker-rich', 50), creep('worker-b', 0)];
  const room = {
    name: 'W0N1',
    controller: { my: true, ticksToDowngrade: 5000, progress: 102, level: 3, pos: new Position(30, 30, 'W0N1') },
    find: () => [],
  };
  const handled = runLogistics(room as unknown as Room, creeps as unknown as Creep[], [], {});
  expect(memory.controllerService!.W0N1!.worker).toBe('worker-rich');
  expect(handled.has('worker-rich')).toBe(true);
  // Surplus upgrade duty: carrying idlers now join the service worker at the
  // controller — the appointment contract is that worker-rich leads, not that
  // it upgrades alone.
  expect(upgraded).toContain('worker-rich');
});
it('lease-held progress refreshes the clock and releases without reappointing in a healthy room', () => {
  class Position {
    roomName: string;
    constructor(public x: number, public y: number, room: string) { this.roomName = room; }
    getRangeTo() { return 10; }
    isNearTo() { return false; }
    findClosestByRange() { return undefined; }
  }
  const now = 60000;
  vi.stubGlobal('Game', { time: now, creeps: {} });
  vi.stubGlobal('RoomPosition', Position);
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
  vi.stubGlobal('FIND_MY_STRUCTURES', 1);
  vi.stubGlobal('FIND_MY_SPAWNS', 2);
  vi.stubGlobal('FIND_MY_CONSTRUCTION_SITES', 3);
  vi.stubGlobal('FIND_STRUCTURES', 4);
  vi.stubGlobal('CONTROLLER_STRUCTURES', { extension: { 3: 0 }, tower: { 3: 0 }, storage: { 3: 0 } });
  vi.stubGlobal('ERR_NOT_IN_RANGE', -10);
  const memory: { controllerService?: Record<string, { progress: number; level: number; lastProgress: number; worker?: string }> } = {
    controllerService: { W0N1: { progress: 200, level: 3, lastProgress: now - 1000, worker: 'worker-a' } },
  };
  vi.stubGlobal('Memory', memory);
  const creep = (name: string, energy: number) => ({
    name, spawning: false, memory: {},
    store: { energy, getUsedCapacity: () => energy, getFreeCapacity: () => 50 - energy },
    pos: new Position(25, 25, 'W0N1'),
    upgradeController: () => 0,
    harvest: () => 0,
  });
  const creeps = [creep('worker-a', 40), creep('worker-b', 20), creep('worker-c', 0)];
  const room = {
    name: 'W0N1',
    // Healthy timer: the recovery-band gate must stay closed here, so the
    // refreshed clock alone decides — and it must not reappoint.
    controller: { my: true, ticksToDowngrade: 20000, progress: 201, level: 3, pos: new Position(30, 30, 'W0N1') },
    find: () => [],
  };
  runLogistics(room as unknown as Room, creeps as unknown as Creep[], [], {});
  expect(memory.controllerService!.W0N1!.lastProgress).toBe(now);
  expect(memory.controllerService!.W0N1!.worker).toBeUndefined();
  // The old `handled.size === 0` assertion pinned the pre-surplus-duty idle
  // room; carrying workers now legitimately work (surplus upgrade) while the
  // released lease stays un-reappointed, which is the contract above.
});

it('never assigns a shipment to a geometrically sealed sink (live ext-seal incident)', () => {
  // 线上事故钉板：扩展 8 邻域全是障碍结构 -> range-1 transfer 几何不可能，
  // 派单板必须当它不存在（否则带能工人在它旁边退避-重派循环 250+ tick）。
  class Position {
    roomName: string;
    constructor(public x: number, public y: number, room = 'W0N1') { this.roomName = room; }
    getRangeTo() { return 5; }
    isNearTo() { return false; }
    inRangeTo() { return false; }
    findClosestByRange() { return undefined; }
    findPathTo() { return []; }
  }
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
  vi.stubGlobal('FIND_MY_STRUCTURES', 1);
  vi.stubGlobal('FIND_MY_SPAWNS', 2);
  vi.stubGlobal('FIND_MY_CONSTRUCTION_SITES', 3);
  vi.stubGlobal('FIND_STRUCTURES', 4);
  vi.stubGlobal('CONTROLLER_STRUCTURES', { extension: { 3: 0 }, tower: { 3: 0 }, storage: { 3: 0 } });
  vi.stubGlobal('ERR_NOT_IN_RANGE', -10);
  vi.stubGlobal('WORK', 'work');
  vi.stubGlobal('OK', 0);
  // 封印现场：ext-sealed (10,10) 的 8 邻域全是障碍结构。
  const sealedRing = new Set(['9,9', '9,10', '9,11', '10,9', '10,11', '11,9', '11,10', '11,11']);
  const sealedExt = {
    id: 'ext-sealed', structureType: 'extension', pos: new Position(10, 10),
    store: { energy: 0, getUsedCapacity: () => 0, getFreeCapacity: () => 50 },
  };
  const fullSpawn = {
    id: 'spawn-full', structureType: 'spawn', pos: new Position(25, 25),
    store: { energy: 300, getUsedCapacity: () => 300, getFreeCapacity: () => 0 },
  };
  const room = {
    name: 'W0N1', energyAvailable: 300,
    controller: { my: true, ticksToDowngrade: 20000, level: 3, pos: new Position(30, 30) },
    lookAt: (x: number, y: number) => sealedRing.has(`${x},${y}`)
      ? [{ type: 'structure', structure: { structureType: 'extension' } }, { type: 'terrain', terrain: 'plain' }]
      : [{ type: 'terrain', terrain: 'plain' }],
    find: (type: number) =>
      type === 1 ? [fullSpawn, sealedExt] : type === 2 ? [fullSpawn] : [],
  };
  const worker = {
    name: 'worker-a', spawning: false, memory: {} as Record<string, unknown>,
    store: { energy: 50, getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
    pos: new Position(12, 12),
    transfer: vi.fn(() => 0), withdraw: vi.fn(() => 0), upgradeController: vi.fn(() => 0),
    harvest: vi.fn(() => 0), build: vi.fn(() => 0), repair: vi.fn(() => 0),
    getActiveBodyparts: () => 1, fatigue: 0,
  };
  runLogistics(room as unknown as Room, [worker] as unknown as Creep[], [], {});
  // 唯一有容量的 sink 是封印扩展 -> 不得形成任何派单/转移
  expect(worker.memory.shipment).toBeUndefined();
  expect(worker.transfer).not.toHaveBeenCalled();
});

describe('upgrade duty quota (M7-4)', () => {
  const base = { sites: 0, ticksToDowngrade: 20000, energyAvailable: 800, idleWorkers: 9 };
  it('posts a fixed duty shift when the room is quiet and rich', () => {
    expect(upgradeDutyQuota(base)).toBe(3);
  });
  it('stands down for construction, downgrade emergencies, and spawn starvation', () => {
    expect(upgradeDutyQuota({ ...base, sites: 1 })).toBe(0);
    expect(upgradeDutyQuota({ ...base, ticksToDowngrade: 2999 })).toBe(0);
    expect(upgradeDutyQuota({ ...base, energyAvailable: 299 })).toBe(0);
  });
  it('never strips the last two runners', () => {
    expect(upgradeDutyQuota({ ...base, idleWorkers: 5 })).toBe(3);
    expect(upgradeDutyQuota({ ...base, idleWorkers: 3 })).toBe(1);
    expect(upgradeDutyQuota({ ...base, idleWorkers: 2 })).toBe(0);
  });
});
