import { describe, expect, it } from 'vitest';
import { roomReadiness, validatePolicy, type Capabilities } from '../../src/domain/config';

describe('policy conflict handling', () => {
  it('preserves the survival reserve and excludes allies from attack targets', () => {
    const result = validatePolicy({ reserveEnergy: 600, targetEnergy: 200, allies: ['friend'], attackTargets: ['friend', 'enemy'] });
    expect(result.policy.targetEnergy).toBe(600);
    expect(result.policy.reserveEnergy).toBe(600);
    expect(result.policy.attackTargets).toEqual(['enemy']);
    expect(result.issues).toHaveLength(2);
  });

  it('rejects non-finite and malformed values without disabling valid overrides', () => {
    const result = validatePolicy({ reserveEnergy: NaN, maxRemoteRooms: -1, targetEnergy: 2000, allies: [1], typo: true });
    expect(result.policy.reserveEnergy).toBe(300);
    expect(result.policy.targetEnergy).toBe(2000);
    expect(result.policy.maxRemoteRooms).toBe(0);
    expect(result.issues).toHaveLength(4);
  });

  it('distinguishes unseen rooms from visible rooms without a spawn and re-evaluates recovery', () => {
    const capabilities: Capabilities = { observedAt: 1, cpuLimit: 20, gcl: 1, rooms: {} };
    const { policy } = validatePolicy({});
    expect(roomReadiness(capabilities, 'W1N1', policy)).toEqual(['room visibility unknown']);
    capabilities.rooms.W1N1 = { visibility: 'visible', owned: true, rcl: 1, spawnCount: 0, energyCapacity: 0 };
    expect(roomReadiness(capabilities, 'W1N1', policy)).toContain('no owned spawn');
    capabilities.rooms.W1N1.spawnCount = 1;
    capabilities.rooms.W1N1.energyCapacity = 300;
    expect(roomReadiness(capabilities, 'W1N1', policy)).toEqual([]);
  });
});
