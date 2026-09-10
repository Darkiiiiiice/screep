import { describe, expect, it } from 'vitest';
import { atLeast, deriveState, energyToReach, UPGRADE_COST } from '@/domain/state';
import type { RoomView, StoreView } from '@/domain/types';

function store(type: string): StoreView {
  return { id: `${type}1`, type, x: 10, y: 10, room: 'W1N1', energy: 0, energyCapacity: 1000 };
}

function room(opts: { level: number; stores?: StoreView[]; my?: boolean }): RoomView {
  return {
    name: 'W1N1',
    controller: {
      id: 'ctrl',
      x: 20,
      y: 20,
      level: opts.level,
      my: opts.my ?? true,
      ticksToDowngrade: 10_000,
      progress: 0,
      progressTotal: 200,
    },
    spawns: [],
    sources: [],
    stores: opts.stores ?? [],
    constructionSites: [],
    creeps: [],
    hostiles: [],
  };
}

describe('deriveState', () => {
  it('treats a room with no owned controller as BOOTSTRAP', () => {
    const r = room({ level: 4, my: false });
    expect(deriveState(r).state).toBe('BOOTSTRAP');
  });

  it('is BOOTSTRAP below RCL 3', () => {
    expect(deriveState(room({ level: 1 })).state).toBe('BOOTSTRAP');
    expect(deriveState(room({ level: 2 })).state).toBe('BOOTSTRAP');
  });

  it('requires a container, not just RCL 3, to reach ESTABLISHED', () => {
    // The level unlocks containers; without one built, harvesters still have to
    // haul by hand, so the hauler-based strategy the state selects would be
    // wrong. Level alone is not sufficient evidence.
    expect(deriveState(room({ level: 3 })).state).toBe('BOOTSTRAP');
    expect(deriveState(room({ level: 3, stores: [store('container')] })).state).toBe('ESTABLISHED');
  });

  it('requires a terminal for MATURE', () => {
    // RCL 6 unlocks the terminal; the link-and-terminal economy is what MATURE
    // means, so the structure is checked as well as the level.
    expect(deriveState(room({ level: 6, stores: [store('container')] })).state).toBe(
      'ESTABLISHED',
    );
    expect(
      deriveState(room({ level: 6, stores: [store('container'), store('terminal')] })).state,
    ).toBe('MATURE');
  });

  it('reaches EXPANSION at RCL 8', () => {
    expect(deriveState(room({ level: 8 })).state).toBe('EXPANSION');
  });

  it('reports a reason for the chosen state', () => {
    // The reason is what makes a live state change explainable rather than
    // mysterious, so it must say something specific.
    expect(deriveState(room({ level: 3 })).reason).toMatch(/no container/);
    expect(deriveState(room({ level: 6, stores: [store('container')] })).reason).toMatch(
      /no terminal/,
    );
  });
});

describe('atLeast', () => {
  it('compares states by their tier, not alphabetically', () => {
    expect(atLeast('ESTABLISHED', 'BOOTSTRAP')).toBe(true);
    expect(atLeast('BOOTSTRAP', 'ESTABLISHED')).toBe(false);
    expect(atLeast('MATURE', 'MATURE')).toBe(true);
  });
});

describe('upgrade costs', () => {
  it('matches the official table at the cliff that shapes the early game', () => {
    // RCL 1->2 costs 200 but 2->3 costs 45,000. That 225x jump is why the
    // BOOTSTRAP->ESTABLISHED gate is about sustained energy, not the level.
    expect(UPGRADE_COST[1]).toBe(200);
    expect(UPGRADE_COST[2]).toBe(45_000);
  });

  it('computes the M3 acceptance figure rather than transcribing it', () => {
    // 200 + 45,000 + 135,000 + 405,000
    expect(energyToReach(5)).toBe(585_200);
  });

  it('accumulates monotonically', () => {
    expect(energyToReach(1)).toBe(0);
    expect(energyToReach(2)).toBe(200);
    expect(energyToReach(4)).toBeGreaterThan(energyToReach(3));
  });
});
