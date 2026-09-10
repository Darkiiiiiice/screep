import { describe, expect, it } from 'vitest';
import { decide, rangeBetween } from '@/domain/roles';
import type { CreepView, RoomView, SourceView, StoreView } from '@/domain/types';

function creep(overrides: Partial<CreepView> = {}): CreepView {
  return {
    name: 'c1',
    role: 'harvester',
    x: 10,
    y: 10,
    room: 'W1N1',
    ticksToLive: 1500,
    energy: 0,
    carryCapacity: 50,
    parts: { work: 2, carry: 1, move: 1 },
    taskId: null,
    ...overrides,
  };
}

function source(id: string, x: number, y: number, energy = 3000): SourceView {
  return { id, x, y, room: 'W1N1', energy, ticksToRegeneration: 0 };
}

function store(id: string, type: string, x: number, y: number, energy: number, cap?: number): StoreView {
  return { id, type, x, y, room: 'W1N1', energy, energyCapacity: cap };
}

function room(overrides: Partial<RoomView> = {}): RoomView {
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
    spawns: [],
    sources: [source('src1', 24, 5)],
    stores: [store('spawn1', 'spawn', 24, 10, 0, 300)],
    constructionSites: [],
    creeps: [],
    hostiles: [],
    ...overrides,
  };
}

describe('rangeBetween', () => {
  it('is Chebyshev distance, matching 8-directional movement', () => {
    // Movement is 8-directional, so a diagonal step covers both axes at once.
    // Using Manhattan here would make the bot move when it could already act.
    expect(rangeBetween({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(3);
    expect(rangeBetween({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(3);
    expect(rangeBetween({ x: 0, y: 0 }, { x: 1, y: 5 })).toBe(5);
    expect(rangeBetween({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
  });
});

describe('fill before travel', () => {
  it('keeps a partially loaded harvester on the source instead of delivering', () => {
    // Measured live failure: delivering on `energy > 0` meant one tick of
    // harvesting (4 energy) followed by five tiles of walking, so the room sat
    // at zero controller progress. Capacity is 50, so filling first multiplies
    // throughput for the same walking.
    const view = room();
    // Adjacent to the source, so the only question is whether it mines more or
    // leaves to deliver.
    const intent = decide(creep({ energy: 4, x: 24, y: 6 }), null, view);

    expect(intent?.kind).toBe('harvest');
  });

  it('delivers once the harvester is full', () => {
    const view = room();
    const intent = decide(creep({ energy: 50, x: 24, y: 11 }), null, view);

    expect(intent?.kind).toBe('transfer');
  });

  it('delivers a partial load when the source has nothing left', () => {
    // Standing still until the source regrows is worse than delivering now.
    const view = room({ sources: [source('src1', 24, 5, 0)] });
    const intent = decide(creep({ energy: 20, x: 24, y: 11 }), null, view);

    expect(intent?.kind).toBe('transfer');
  });

  it('does nothing with no energy and no source to mine', () => {
    const view = room({ sources: [] });
    expect(decide(creep({ energy: 0 }), null, view)).toBeNull();
  });

  it('moves toward a source it is not adjacent to', () => {
    const view = room();
    const intent = decide(creep({ x: 30, y: 30 }), null, view);

    expect(intent?.kind).toBe('moveTo');
  });

  it('harvests in place when adjacent to the source', () => {
    const view = room();
    const intent = decide(creep({ x: 24, y: 6 }), null, view);

    expect(intent?.kind).toBe('harvest');
  });

  it('applies the same rule to the upgrader', () => {
    // Worse for the upgrader than the harvester: the controller is far from the
    // sources, so upgrading 2 energy per round trip is almost all walking.
    const view = room({ stores: [store('spawn1', 'spawn', 24, 10, 0, 300)] });
    const hoarding = decide(creep({ role: 'upgrader', energy: 3, x: 24, y: 6 }), null, view);
    const full = decide(creep({ role: 'upgrader', energy: 50, x: 43, y: 18 }), null, view);

    expect(hoarding?.kind).toBe('harvest');
    expect(full?.kind).toBe('upgrade');
  });

  it('applies the same rule to the builder', () => {
    const view = room({
      sources: [source('src1', 24, 5)],
      constructionSites: [
        {
          id: 'site1',
          x: 30,
          y: 30,
          room: 'W1N1',
          structureType: 'road',
          progress: 0,
          progressTotal: 100,
        },
      ],
    });

    expect(decide(creep({ role: 'builder', energy: 4, x: 24, y: 6 }), null, view)?.kind).toBe(
      'harvest',
    );
    expect(
      decide(creep({ role: 'builder', energy: 50, x: 30, y: 29 }), null, view)?.kind,
    ).toBe('build');
  });
});

describe('energy source preference', () => {
  it('prefers a buffer over the spawn, whose stock is reserved for spawning', () => {
    // Draining the spawn trades long-term survival for short-term progress: the
    // spawn's energy is what replaces a dead creep.
    const view = room({
      stores: [
        store('spawn1', 'spawn', 24, 10, 300, 300),
        store('cont1', 'container', 30, 30, 500, 2000),
      ],
    });
    const intent = decide(creep({ role: 'upgrader', x: 30, y: 31 }), null, view);

    expect(intent?.kind).toBe('withdraw');
    expect((intent as { targetId: string }).targetId).toBe('cont1');
  });

  it('falls back to self-harvesting when no buffer exists', () => {
    // At BOOTSTRAP there are no containers, so an upgrader that only drained the
    // spawn would starve the colony of replacements.
    const view = room({ stores: [store('spawn1', 'spawn', 24, 10, 300, 300)] });
    const intent = decide(creep({ role: 'upgrader', energy: 0, x: 24, y: 6 }), null, view);

    expect(intent?.kind).toBe('harvest');
  });
});

describe('ownership safety', () => {
  it('does nothing in a room whose controller is not ours', () => {
    // Safety property: no intent may spend another player's resources.
    const view = room({
      controller: {
        id: 'ctrl',
        x: 43,
        y: 17,
        level: 4,
        my: false,
        ticksToDowngrade: 20_000,
        progress: 0,
        progressTotal: 200,
      },
    });

    expect(decide(creep({ role: 'upgrader', energy: 50 }), null, view)).toBeNull();
  });
});
