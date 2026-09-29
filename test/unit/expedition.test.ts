import { describe, expect, it } from 'vitest';
import { attackerSpawnNeed, evaluateRaidTargets, RAID_MAX_DISTANCE } from '../../src/domain/expedition';
import type { RoomIntel } from '../../src/domain/intel';

const room = (over: Partial<RoomIntel>): RoomIntel => ({
  observedAt: 1000,
  sources: [{ id: 's1', x: 20, y: 20 }, { id: 's2', x: 30, y: 30 }],
  threat: { armed: 0, towers: 0, hostiles: [], keeperLairs: 0, structures: 0 },
  controller: { level: 0, reserver: 'npc', reservationTicks: 2000 },
  ...over,
} as RoomIntel);

const now = 1000;

describe('raid target board (M7-3)', () => {
  it('picks foreign-reserved unowned rooms, soonest expiry first', () => {
    const targets = evaluateRaidTargets({
      rooms: { W0N2: room({}), W1N1: room({ controller: { level: 0, reserver: 'npc2', reservationTicks: 500 } }) },
      distances: { W0N2: 1, W1N1: 1 }, me: 'me', now,
    });
    expect(targets[0]?.name).toBe('W1N1');
    expect(targets[0]?.effectiveTicks).toBe(500);
  });
  it('decays the reservation by observation age', () => {
    const targets = evaluateRaidTargets({
      rooms: { W0N2: room({ observedAt: 400, controller: { level: 0, reserver: 'npc', reservationTicks: 500 } }) },
      distances: { W0N2: 1 }, me: 'me', now,
    });
    expect(targets).toEqual([]); // 已自然到期,不值得拆
  });
  it('skips owned, self-reserved, threatened, and far rooms', () => {
    const targets = evaluateRaidTargets({
      rooms: {
        own: room({ controller: { level: 1, owner: 'npc', reserver: undefined, reservationTicks: undefined } }),
        mine: room({ controller: { level: 0, reserver: 'me', reservationTicks: 2000 } }),
        war: room({ threat: { armed: 3, towers: 0, hostiles: 1, keeperLairs: 0, structures: 0 } }),
        far: room({}),
        empty: room({ sources: [] }),
      },
      distances: { own: 1, mine: 1, war: 1, far: RAID_MAX_DISTANCE + 1, empty: 1 },
      me: 'me', now,
    });
    expect(targets).toEqual([]);
  });
});

describe('attacker spawn need (M7-3)', () => {
  const targets = [{ name: 'W0N2', distance: 1, effectiveTicks: 1000 }];
  const base = { targets, attackerAlive: false, workers: 6, capacity: 800, energyAvailable: 800, now: 1000 };

  it('opens a ticket against the top raid target', () => {
    expect(attackerSpawnNeed(base)).toBe('W0N2');
  });
  it('stands down without targets, while deployed, under floors, or cooling down', () => {
    expect(attackerSpawnNeed({ ...base, targets: [] })).toBeNull();
    expect(attackerSpawnNeed({ ...base, attackerAlive: true })).toBeNull();
    expect(attackerSpawnNeed({ ...base, workers: 3 })).toBeNull();
    expect(attackerSpawnNeed({ ...base, capacity: 300 })).toBeNull();
    expect(attackerSpawnNeed({ ...base, energyAvailable: 500 })).toBeNull();
    expect(attackerSpawnNeed({ ...base, lastDeathAt: 900 })).toBeNull();
    expect(attackerSpawnNeed({ ...base, lastDeathAt: 800 })).toBe('W0N2'); // 冷却 150 已过
  });
});
