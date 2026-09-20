import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUARD_COST, GUARD_HANDOFF_TTL, GUARD_LOSS_BUDGET, guardSpawnNeed } from '../../src/domain/combat';
import { driveGuards } from '../../src/game/defense';

afterEach(() => vi.unstubAllGlobals());

const armed = (armed: number, hits = 1000) => ({ armed, hits });

const need = (over: Partial<Parameters<typeof guardSpawnNeed>[0]> = {}) =>
  guardSpawnNeed({
    hostiles: [armed(2)],
    guards: 0, guardTtl: undefined, capacity: 800, energyAvailable: 800, losses: 0, ...over,
  } as Parameters<typeof guardSpawnNeed>[0]);

describe('guard spawn gate', () => {
  it('spawns only against armed hostiles', () => {
    expect(need()).toBe(true);
    expect(need({ hostiles: [armed(0, 500)] })).toBe(false);
    expect(need({ hostiles: [] })).toBe(false);
  });

  it('stops reinforcing after the loss budget is spent (劣势不添兵)', () => {
    expect(need({ losses: GUARD_LOSS_BUDGET - 1 })).toBe(true);
    expect(need({ losses: GUARD_LOSS_BUDGET })).toBe(false);
    expect(need({ losses: GUARD_LOSS_BUDGET + 3 })).toBe(false);
  });

  it('respects capacity and available energy', () => {
    expect(need({ capacity: GUARD_COST - 1 })).toBe(false);
    expect(need({ energyAvailable: GUARD_COST - 1 })).toBe(false);
  });

  it('hands off via TTL instead of stacking guards', () => {
    expect(need({ guards: 1, guardTtl: GUARD_HANDOFF_TTL + 1 })).toBe(false);
    expect(need({ guards: 1, guardTtl: GUARD_HANDOFF_TTL - 1 })).toBe(true);
    expect(need({ guards: 2, guardTtl: 10 })).toBe(true);
  });
});

function creepStub(name: string, over: Record<string, unknown> = {}) {
  return {
    name, id: `id-${name}`, memory: { role: 'guard' }, room: { name: 'W0N1' },
    hits: 300, hitsMax: 300,
    pos: { inRangeTo: () => false, findClosestByRange: () => null,
      x: 25, y: 25, roomName: 'W0N1' },
    moveTo: vi.fn(), attack: vi.fn(),
    ...over,
  };
}

describe('guard driver', () => {
  it('charges the armed hostile and attacks in range', () => {
    const foe = { id: 'foe', name: 'Foe', hits: 1000, hitsMax: 1000,
      pos: { x: 30, y: 30, roomName: 'W0N1', inRangeTo: (c: { pos: { x: number } }) => Math.abs(c.pos.x - 30) <= 1 },
      body: [{ type: 'attack' }], owner: { username: 'Invader' } };
    const guard = creepStub('guard-1', {
      pos: { x: 30, y: 31, roomName: 'W0N1', inRangeTo: (t: { pos: { x: number; y: number } }) => Math.abs(30 - t.pos.x) <= 1 && Math.abs(31 - t.pos.y) <= 1, findClosestByRange: () => foe },
    });
    vi.stubGlobal('Game', { time: 100, creeps: { 'guard-1': guard } });
    vi.stubGlobal('Memory', {});
    vi.stubGlobal('FIND_HOSTILE_CREEPS', 2);
    vi.stubGlobal('FIND_MY_SPAWNS', 5);
    vi.stubGlobal('ATTACK', 'attack');
    vi.stubGlobal('RANGED_ATTACK', 'rangedAttack');
    const room = { name: 'W0N1', find: (k: number) => (k === 2 ? [foe] : []) } as unknown as Room;
    driveGuards(room, []);
    expect(guard.attack).toHaveBeenCalledWith(foe);
    expect(guard.moveTo).not.toHaveBeenCalled();
  });

  it('retreats toward the spawn below the retreat ratio', () => {
    const guard = creepStub('guard-2', { hits: 60, hitsMax: 300 });
    vi.stubGlobal('Game', { time: 100, creeps: { 'guard-2': guard } });
    vi.stubGlobal('Memory', {});
    vi.stubGlobal('FIND_HOSTILE_CREEPS', 2);
    vi.stubGlobal('FIND_MY_SPAWNS', 5);
    vi.stubGlobal('ATTACK', 'attack');
    vi.stubGlobal('RANGED_ATTACK', 'rangedAttack');
    const room = {
      name: 'W0N1',
      find: (k: number) => (k === 2 ? [] : k === 5 ? [{ pos: { x: 25, y: 25, roomName: 'W0N1' } }] : []),
    } as unknown as Room;
    driveGuards(room, []);
    expect(guard.moveTo).toHaveBeenCalled();
    expect(guard.attack).not.toHaveBeenCalled();
  });

  it('books a loss only when the guard vanishes during an armed threat', () => {
    const prior = { count: 0, since: 90, names: ['guard-lost'] };
    const survivor = creepStub('guard-here');
    vi.stubGlobal('Game', { time: 100, creeps: { 'guard-here': survivor } });
    vi.stubGlobal('Memory', { guardLoss: { W0N1: prior } });
    vi.stubGlobal('FIND_HOSTILE_CREEPS', 2);
    vi.stubGlobal('FIND_MY_SPAWNS', 5);
    vi.stubGlobal('ATTACK', 'attack');
    vi.stubGlobal('RANGED_ATTACK', 'rangedAttack');
    const foe = { id: 'foe', name: 'Foe', hits: 10, hitsMax: 10, pos: { x: 30, y: 30, roomName: 'W0N1', inRangeTo: () => false },
      body: [{ type: 'attack' }], owner: { username: 'Invader' } };
    const room = { name: 'W0N1', find: (k: number) => (k === 2 ? [foe] : []) } as unknown as Room;
    driveGuards(room, []);
    expect(prior.count).toBe(1);
    expect(prior.names).toEqual(['guard-here']);
  });
});
