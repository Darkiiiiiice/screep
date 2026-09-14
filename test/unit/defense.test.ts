import { afterEach, describe, expect, it, vi } from 'vitest';
import { threatScore, towerTargets } from '../../src/domain/defense';
import { runDefense } from '../../src/game/defense';

afterEach(() => vi.unstubAllGlobals());

const hostile = (id: string, damageParts: number, proximity: number, hits = 1000) =>
  ({ id, hits, damageParts, proximity });

describe('threat ranking', () => {
  it('ranks damage potential over distance and ignores zero-threat scouts', () => {
    const raider = hostile('raider', 10, 20);
    const dismantler = hostile('dismantler', 8, 5);
    expect(threatScore(raider)).toBeGreaterThan(threatScore(dismantler));
    expect(threatScore(hostile('scout', 0, 1))).toBeGreaterThan(0);
  });

  it('orders focus targets and skips empty towers and dead hostiles', () => {
    const towers = [{ id: 't1', energy: 10 }, { id: 't2', energy: 5 }];
    const targets = towerTargets(towers, [hostile('b', 5, 30), hostile('a', 10, 30), hostile('corpse', 3, 3, 0)]);
    expect(targets[0]).toBe('a');
    expect(targets).toContain('b');
    expect(targets).not.toContain('corpse');
    expect(towerTargets([{ id: 't1', energy: 5 }], [hostile('a', 5, 5)])).toEqual([]);
    expect(towerTargets([], [hostile('a', 5, 5)])).toEqual([]);
  });
});

function towerStub(id: string, energy: number) {
  return {
    id, structureType: 'tower', energy, energyCapacity: 1000,
    store: { getUsedCapacity: () => energy },
    attack: vi.fn(() => 0), heal: vi.fn(() => 0), repair: vi.fn(() => 0),
  };
}

function roomStub({ towers, hostiles = [], own = [], structures = [], spawns = [] }: {
  towers: unknown[]; hostiles?: unknown[]; own?: unknown[]; structures?: unknown[]; spawns?: unknown[];
}) {
  vi.stubGlobal('Game', { time: 1000, creeps: {} });
  vi.stubGlobal('Memory', {});
  vi.stubGlobal('FIND_MY_STRUCTURES', 1);
  vi.stubGlobal('FIND_HOSTILE_CREEPS', 2);
  vi.stubGlobal('RESOURCE_ENERGY', 'energy');
  vi.stubGlobal('FIND_MY_CREEPS', 3);
  vi.stubGlobal('FIND_STRUCTURES', 4);
  vi.stubGlobal('FIND_MY_SPAWNS', 5);
  vi.stubGlobal('STRUCTURE_TOWER', 'tower');
  vi.stubGlobal('STRUCTURE_WALL', 'constructedWall');
  vi.stubGlobal('STRUCTURE_RAMPART', 'rampart');
  vi.stubGlobal('STRUCTURE_CONTAINER', 'container');
  vi.stubGlobal('STRUCTURE_SPAWN', 'spawn');
  vi.stubGlobal('STRUCTURE_EXTENSION', 'extension');
  vi.stubGlobal('ATTACK', 'attack');
  vi.stubGlobal('RANGED_ATTACK', 'rangedAttack');
  vi.stubGlobal('WORK', 'work');
  vi.stubGlobal('OK', 0);
  return {
    find: (kind: number) =>
      kind === 1 ? [...towers, ...spawns] : kind === 2 ? hostiles : kind === 3 ? own : kind === 4 ? structures : spawns,
  };
}

describe('tower defense intents', () => {
  it('focus-fires the top threat with every ready tower', () => {
    const t1 = towerStub('t1', 500);
    const t2 = towerStub('t2', 500);
    const raider = { id: 'raider', hits: 1000, hitsMax: 1000, pos: { x: 30, y: 30 },
      body: [{ type: 'attack' }, { type: 'attack' }, { type: 'carry' }] };
    const room = roomStub({ towers: [t1, t2], hostiles: [raider], spawns: [{ pos: { x: 25, y: 25 } }] });
    runDefense(room as unknown as Room);
    expect(t1.attack).toHaveBeenCalledExactlyOnceWith(raider);
    expect(t2.attack).toHaveBeenCalledExactlyOnceWith(raider);
  });

  it('never fires without targets and treats unarmed creeps as harmless', () => {
    const t1 = towerStub('t1', 500);
    const scout = { id: 'scout', hits: 500, hitsMax: 500, pos: { x: 25, y: 10 },
      body: [{ type: 'move' }, { type: 'move' }] };
    const room = roomStub({ towers: [t1], hostiles: [scout], spawns: [{ pos: { x: 25, y: 25 } }] });
    runDefense(room as unknown as Room);
    expect(t1.attack).not.toHaveBeenCalled();
    expect(t1.repair).not.toHaveBeenCalled();
  });

  it('heals the most damaged own creep when no hostile stands', () => {
    const t1 = towerStub('t1', 500);
    const hurt = { id: 'hurt', hits: 100, hitsMax: 300 };
    const room = roomStub({ towers: [t1], own: [hurt], spawns: [{ pos: { x: 25, y: 25 } }] });
    runDefense(room as unknown as Room);
    expect(t1.heal).toHaveBeenCalledExactlyOnceWith(hurt);
    expect(t1.repair).not.toHaveBeenCalled();
  });

  it('channels spare energy into the worst critical structure', () => {
    const t1 = towerStub('t1', 500);
    const spawn = { id: 'spawn-id', structureType: 'spawn', hits: 1000, hitsMax: 5000 };
    const extension = { id: 'ext-id', structureType: 'extension', hits: 4000, hitsMax: 5000 };
    const room = roomStub({ towers: [t1], structures: [spawn, extension], spawns: [{ pos: { x: 25, y: 25 } }] });
    runDefense(room as unknown as Room);
    expect(t1.repair).toHaveBeenCalledExactlyOnceWith(spawn);
  });
});
