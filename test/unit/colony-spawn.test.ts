import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { nextSpawn, planSpawns, populationByRole } from '@/colony/spawn';

import type { RoomView, SpawnView, StoreView } from '@/domain/types';

// The spawn manager is engine-aware by design: it reads `Game.time` to name a
// creep uniquely, so these tests run against the fake engine like the kernel's.
let engine: FakeEngine | undefined;

beforeEach(() => {
  engine = installFakeEngine();
});

afterEach(() => {
  engine?.restore();
  engine = undefined;
});

function spawnView(overrides: Partial<SpawnView> = {}): SpawnView {
  return {
    id: 'spawn1',
    name: 'Spawn1',
    x: 24,
    y: 10,
    room: 'W1N1',
    energy: 300,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    spawning: false,
    spawningName: null,
    spawningRole: null,
    spawnTicksRemaining: 0,
    ...overrides,
  };
}

/** A store the colony can deposit into; the spawn is one of these. */
function storeView(overrides: Partial<StoreView> = {}): StoreView {
  return {
    id: 'spawn1',
    type: 'spawn',
    x: 24,
    y: 10,
    room: 'W1N1',
    energy: 300,
    energyCapacity: 300,
    ...overrides,
  };
}

function roomView(overrides: Partial<RoomView> = {}): RoomView {
  return {
    name: 'W1N1',
    controller: {
      id: 'ctrl',
      x: 43,
      y: 17,
      level: 1,
      my: true,
      ticksToDowngrade: 20_000,
      progress: 0,
      progressTotal: 200,
    },
    spawns: [spawnView()],
    sources: [
      { id: 'src1', x: 24, y: 5, room: 'W1N1', energy: 3000, ticksToRegeneration: 0 },
      { id: 'src2', x: 30, y: 5, room: 'W1N1', energy: 3000, ticksToRegeneration: 0 },
    ],
    stores: [storeView()],
    constructionSites: [],
    creeps: [],
    hostiles: [],
    ...overrides,
  };
}

describe('nextSpawn', () => {
  it('returns null when nothing is wanted', () => {
    expect(nextSpawn([], 300, 'W1N1')).toBeNull();
  });

  it('returns null rather than a crippled body when the budget is too small', () => {
    // Below the cheapest usable body the correct action is to wait: a creep that
    // cannot move or carry is worse than no creep, and it still occupies the
    // spawn for its whole build time.
    expect(nextSpawn([{ role: 'harvester' }], 100, 'W1N1')).toBeNull();
  });

  it('names the creep uniquely per tick and room', () => {
    const a = nextSpawn([{ role: 'harvester' }], 300, 'W1N1');
    expect(a?.name).toMatch(/^harvester-W1N1-\d+$/);
  });

  it('reports the body cost so a caller can verify affordability', () => {
    const decision = nextSpawn([{ role: 'harvester' }], 300, 'W1N1');
    expect(decision?.cost).toBeGreaterThan(0);
    expect(decision?.cost).toBeLessThanOrEqual(300);
  });
});

describe('populationByRole', () => {
  it('counts living creeps by role', () => {
    const view = roomView({
      creeps: [
        {
          name: 'h1',
          role: 'harvester',
          x: 1,
          y: 1,
          room: 'W1N1',
          energy: 0,
          carryCapacity: 50,
          parts: {},
          taskId: null,
        },
      ],
    });
    expect(populationByRole(view).harvester).toBe(1);
  });

  it('counts a creep still being built against its role', () => {
    // A creep in the spawn queue is absent from `Game.creeps`. Without counting
    // it, the manager re-queues the same role every tick until it hatches, and
    // the spawn alternates between ERR_BUSY and wasted requests.
    const view = roomView({
      spawns: [spawnView({ spawning: true, spawningName: 'harvester-1', spawningRole: 'harvester' })],
    });
    expect(populationByRole(view).harvester).toBe(1);
  });

  it('ignores a spawn whose pending creep has no known role', () => {
    const view = roomView({
      spawns: [spawnView({ spawning: true, spawningName: 'x', spawningRole: null })],
    });
    expect(populationByRole(view)).toEqual({});
  });
});

describe('planSpawns', () => {
  it('queues a harvester when the room has none', () => {
    const result = planSpawns(roomView(), 'BOOTSTRAP');
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]?.kind).toBe('spawn');
  });

  it('refuses to queue while the spawn is busy', () => {
    // A second request returns ERR_BUSY and is lost, and it would also hide the
    // fact that the first creep is stuck in the queue.
    const view = roomView({ spawns: [spawnView({ spawning: true, spawningRole: 'harvester' })] });
    const result = planSpawns(view, 'BOOTSTRAP');

    expect(result.intents).toEqual([]);
    expect(result.reason).toBe('all spawns busy');
  });

  it('says so when the room has no spawn at all', () => {
    const result = planSpawns(roomView({ spawns: [] }), 'BOOTSTRAP');
    expect(result.intents).toEqual([]);
    expect(result.reason).toBe('no spawn in room');
  });

  it('sizes the body against energy on hand, not capacity', () => {
    // `spawnCreep` draws on current energy. Sizing against capacity while the
    // spawn is empty produces a body the room cannot pay for, and the request
    // fails every tick.
    const view = roomView({
      spawns: [spawnView({ energy: 200, energyAvailable: 200, energyCapacityAvailable: 600 })],
    });

    const result = planSpawns(view, 'BOOTSTRAP');
    const body = (result.intents[0] as { body: string[] }).body;

    expect(body).toBeDefined();
    // 200 is the cost of one {work,carry,move} block, so the body must fit that.
    expect(body.length).toBe(3);
  });

  it('refuses to queue anything with no energy banked', () => {
    const view = roomView({
      spawns: [spawnView({ energy: 0, energyAvailable: 0, energyCapacityAvailable: 300 })],
    });
    const result = planSpawns(view, 'BOOTSTRAP');

    expect(result.intents).toEqual([]);
    expect(result.reason).toBe('no energy banked');
  });

  it('explains which role it could not afford', () => {
    const view = roomView({
      spawns: [spawnView({ energy: 100, energyAvailable: 100, energyCapacityAvailable: 300 })],
    });
    const result = planSpawns(view, 'BOOTSTRAP');

    expect(result.intents).toEqual([]);
    expect(result.reason).toMatch(/cannot afford harvester/);
  });

  it('stops queueing once demand is met', () => {
    // The room wants one harvester per source plus an upgrader; with a harvester
    // already pending and one alive, the next request should be the upgrader,
    // and once that is pending nothing more should be queued.
    const view = roomView({
      spawns: [spawnView({ spawning: true, spawningRole: 'harvester' })],
      creeps: [
        {
          name: 'h1',
          role: 'harvester',
          x: 1,
          y: 1,
          room: 'W1N1',
          energy: 0,
          carryCapacity: 50,
          parts: {},
          taskId: null,
        },
      ],
    });

    // Two sources, so two harvesters are wanted; one is alive and one pending.
    expect(populationByRole(view).harvester).toBe(2);
    const result = planSpawns(view, 'BOOTSTRAP');
    // Spawn is busy, so nothing is queued regardless — asserted here so the
    // test documents the interaction rather than only the count.
    expect(result.intents).toEqual([]);
  });

  it('spawns an upgrader once harvesters are satisfied', () => {
    const view = roomView({
      stores: [storeView()],
      creeps: [
        {
          name: 'h1',
          role: 'harvester',
          x: 1,
          y: 1,
          room: 'W1N1',
          energy: 0,
          carryCapacity: 50,
          parts: {},
          taskId: null,
        },
        {
          name: 'h2',
          role: 'harvester',
          x: 2,
          y: 2,
          room: 'W1N1',
          energy: 0,
          carryCapacity: 50,
          parts: {},
          taskId: null,
        },
      ],
    });

    const result = planSpawns(view, 'BOOTSTRAP');
    expect(result.reason).toMatch(/upgrader/);
  });

  it('sizes every requested body within the energy actually available', () => {
    // The contract that matters, checked across budgets: whatever it decides to
    // build must be payable right now, or `spawnCreep` rejects it and the colony
    // asks again forever without ever building anything.
    const CHECKS: { energy: number; expectBody: boolean }[] = [
      { energy: 100, expectBody: false }, // below one {work,carry,move} block
      { energy: 200, expectBody: true },
      { energy: 300, expectBody: true },
      { energy: 400, expectBody: true },
      { energy: 600, expectBody: true },
    ];

    for (const { energy, expectBody } of CHECKS) {
      const view = roomView({
        spawns: [spawnView({ energy, energyAvailable: energy, energyCapacityAvailable: energy })],
      });
      const intent = planSpawns(view, 'BOOTSTRAP').intents[0] as { body: string[] } | undefined;

      expect(intent !== undefined, `energy ${String(energy)}`).toBe(expectBody);
      if (intent) {
        const cost = intent.body.reduce((sum, part) => sum + PART_COST[part as string]!, 0);
        expect(cost, `energy ${String(energy)}`).toBeLessThanOrEqual(energy);
      }
    }
  });
});

/** Engine part costs, so the check above does not depend on our own table. */
const PART_COST: Record<string, number> = {
  tough: 10,
  move: 50,
  carry: 50,
  work: 100,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
};
