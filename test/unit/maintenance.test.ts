import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPAIR_THRESHOLD, selectRepairTarget, URGENT_REPAIR_THRESHOLD } from '../../src/domain/maintenance';
import { runLogistics } from '../../src/game/logistics';

afterEach(() => vi.unstubAllGlobals());

const structure = (id: string, hits: number, hitsMax = 250000, critical = true, type = 'container') =>
  ({ id, structureType: type, hits, hitsMax, critical });

describe('repair triage', () => {
  it('ignores empty input, full health, and structures at the entry threshold', () => {
    expect(selectRepairTarget([])).toBeUndefined();
    expect(selectRepairTarget([structure('a', 250000)])).toBeUndefined();
    expect(selectRepairTarget([structure('a', 250000 * REPAIR_THRESHOLD)])).toBeUndefined();
    expect(selectRepairTarget([structure('a', 0, 0)])).toBeUndefined();
  });

  it('prefers urgent damage over healthy critical infrastructure', () => {
    const road = structure('road', 100, 1000, true, 'road'); // 0.10 urgent
    const container = structure('container', 100000); // 0.40
    expect(selectRepairTarget([container, road])!.id).toBe('road');
    expect(selectRepairTarget([container, road])!.urgent).toBe(true);
  });

  it('queues decayed dead weight without preemption', () => {
    // Below the urgent line but not income-critical: selected for idle repair,
    // never urgent enough to pause construction.
    const legacy = structure('legacy', 0.2 * 250000, 250000, false); // 0.20
    const selection = selectRepairTarget([legacy]);
    expect(selection!.id).toBe('legacy');
    expect(selection!.urgent).toBe(false);
  });

  it('breaks ties by criticality, then lowest ratio, then id', () => {
    const wall = structure('wall', 0.2 * 100000, 100000, false, 'constructedWall'); // 0.20 dead weight
    const container = structure('container', 0.24 * 250000, 250000); // 0.24 urgent critical
    expect(selectRepairTarget([wall, container])!.id).toBe('container');
    const lower = structure('c-low', 10000); // 0.04 urgent
    const higher = structure('c-high', 50000); // 0.20 urgent
    expect(selectRepairTarget([higher, lower])!.id).toBe('c-low');
    const a = structure('same-a', 10000);
    const b = structure('same-b', 10000);
    expect(selectRepairTarget([b, a])!.id).toBe('same-a');
  });

  it('marks critical damage below the urgent threshold as urgent', () => {
    const selection = selectRepairTarget([structure('a', 250000 * URGENT_REPAIR_THRESHOLD - 1)]);
    expect(selection!.urgent).toBe(true);
    const deadWeight = structure('b', 250000 * URGENT_REPAIR_THRESHOLD - 1, 250000, false);
    expect(selectRepairTarget([deadWeight])!.urgent).toBe(false);
  });
});

class Position {
  roomName = 'W0N1';
  constructor(public x: number, public y: number) {}
  getRangeTo(target: Position) { return Math.abs(this.x - target.x) + Math.abs(this.y - target.y); }
  findClosestByRange<T>(list: T[]) { return list[0]; }
  isEqualTo(target: Position) { return this.x === target.x && this.y === target.y; }
  isNearTo() { return false; }
  lookFor() { return []; }
}

function engineStub(containers: unknown[], sites: unknown[] = []) {
  const spawn = { id: 'spawn-id', structureType: 'spawn', pos: new Position(25, 25), store: { getFreeCapacity: () => 10 } };
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
  vi.stubGlobal('CONTROLLER_STRUCTURES', { extension: { 1: 0, 2: 5 } });
  vi.stubGlobal('LOOK_TERRAIN', 'terrain');
  vi.stubGlobal('LOOK_STRUCTURES', 'structure');
  vi.stubGlobal('LOOK_CONSTRUCTION_SITES', 'constructionSite');
  return {
    name: 'W0N1',
    controller: { ticksToDowngrade: 20000, level: 2 },
    createConstructionSite: () => 0,
    find: (kind: number) =>
      kind === 1 ? containers : kind === 2 ? [spawn] : kind === 3 ? [spawn] : sites,
  };
}

const containerStub = (id: string, hits: number, energy = 0) => ({
  id, structureType: 'container', pos: new Position(15, 15), hits, hitsMax: 250000,
  store: { energy, getUsedCapacity: () => energy, getFreeCapacity: () => 0 },
});

const workerStub = (name: string, energy: number) => ({
  name, spawning: false, memory: {} as Record<string, unknown>,
  store: { energy, getUsedCapacity: () => energy, getFreeCapacity: () => 50 - energy },
  pos: new Position(16, 16), getActiveBodyparts: () => 1,
  repair: vi.fn(() => 0), withdraw: vi.fn(() => 0), harvest: vi.fn(() => 0), transfer: vi.fn(() => 0),
});

describe('repair assignment in logistics', () => {
  it('sends a spare worker to repair urgent damage and pauses construction', () => {
    const c1 = containerStub('c1', 10000, 200); // 0.04, stocked → income-critical → urgent
    const c2 = containerStub('c2', 250000);
    const site = { id: 'site-1', structureType: 'extension', pos: new Position(20, 20), progress: 0, progressTotal: 3000 };
    const room = engineStub([c1, c2], [site]);
    // Four workers sit above both floors, so only the urgent gate can stop construction.
    const workers = [workerStub('w1', 30), workerStub('w2', 0), workerStub('w3', 0), workerStub('w4', 0)];
    const handled = runLogistics(room as unknown as Room, workers as unknown as Creep[], [], {});
    expect(handled.has('w1')).toBe(true);
    expect(workers[0]!.memory.repairTarget).toBe('c1');
    expect(workers[0]!.repair).toHaveBeenCalledExactlyOnceWith(c1);
    // Urgent repair preempts construction: no builder is started for the site.
    expect(workers.slice(1).every(w => w.memory.containerBuilder === undefined && w.memory.containerSite === undefined)).toBe(true);
  });

  it('never lets empty decayed legacy containers pause construction', () => {
    const c1 = containerStub('c1', 10000); // 0.04 but empty: dead weight, not urgent
    const site = { id: 'site-1', structureType: 'extension', pos: new Position(20, 20), progress: 0, progressTotal: 3000 };
    const room = engineStub([c1], [site]);
    const workers = [workerStub('w1', 30), workerStub('w2', 0), workerStub('w3', 0), workerStub('w4', 0)];
    runLogistics(room as unknown as Room, workers as unknown as Creep[], [], {});
    // Idle repair still happens above the floor…
    expect(workers.some(w => w.memory.repairTarget === 'c1')).toBe(true);
    // …but construction is never preempted for dead weight.
    expect(workers.some(w => w.memory.containerBuilder === true && w.memory.containerSite === 'site-1')).toBe(true);
  });

  it('reserves the two-worker economy floor for non-urgent damage', () => {
    const c1 = containerStub('c1', 125000); // 0.50, below 0.8 but not urgent
    const room = engineStub([c1]);
    const pair = [workerStub('w1', 30), workerStub('w2', 0)];
    runLogistics(room as unknown as Room, pair as unknown as Creep[], [], {});
    expect(pair.every(w => w.memory.repairTarget === undefined)).toBe(true);
    const trio = [workerStub('w3', 30), workerStub('w4', 0), workerStub('w5', 0)];
    runLogistics(room as unknown as Room, trio as unknown as Creep[], [], {});
    expect(trio[0]!.memory.repairTarget).toBe('c1');
    expect(trio[0]!.repair).toHaveBeenCalledExactlyOnceWith(c1);
  });

  it('an empty repairer withdraws from a stocked container instead of repairing', () => {
    const c1 = containerStub('c1', 10000, 200);
    const room = engineStub([c1]);
    const worker = workerStub('w1', 0);
    runLogistics(room as unknown as Room, [worker] as unknown as Creep[], [], {});
    // One worker cannot cover repair above the floor; give the room a second spare.
    const workers = [workerStub('w1', 0), workerStub('w2', 0)];
    runLogistics(room as unknown as Room, workers as unknown as Creep[], [], {});
    expect(workers[0]!.withdraw).toHaveBeenCalledExactlyOnceWith(c1, 'energy');
    expect(workers[0]!.repair).not.toHaveBeenCalled();
  });

  it('drops stale repair flags so a destroyed target frees its worker', () => {
    const c1 = containerStub('c1', 10000);
    const room = engineStub([c1]);
    const stale = workerStub('w1', 30);
    stale.memory.repairTarget = 'destroyed-container';
    const workers = [stale, workerStub('w2', 0), workerStub('w3', 0)];
    runLogistics(room as unknown as Room, workers as unknown as Creep[], [], {});
    expect(stale.memory.repairTarget).toBe('c1');
    expect(stale.repair).toHaveBeenCalledExactlyOnceWith(c1);
  });

  it('releases a worker once its target heals back above the threshold', () => {
    const c1 = containerStub('c1', 100000); // 0.40
    const room = engineStub([c1]);
    const worker = workerStub('w1', 30);
    worker.memory.repairTarget = 'c1';
    c1.hits = 210000; // healed above 0.8
    c1.store.energy = 0;
    const workers = [worker, workerStub('w2', 0), workerStub('w3', 0)];
    runLogistics(room as unknown as Room, workers as unknown as Creep[], [], {});
    expect(worker.memory.repairTarget).toBeUndefined();
    expect(worker.repair).not.toHaveBeenCalled();
  });
});
