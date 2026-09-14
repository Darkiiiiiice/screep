/** Configuration is validated before any planner can spend resources. */
export interface Policy {
  reserveEnergy: number;
  targetEnergy: number;
  maxRemoteRooms: number;
  allies: string[];
  attackTargets: string[];
}

export interface Capabilities {
  observedAt: number;
  cpuLimit: number;
  gcl: number;
  rooms: Record<string, {
    visibility: 'visible' | 'unknown';
    owned: boolean;
    rcl: number | null;
    spawnCount: number | null;
    energyCapacity: number | null;
  }>;
}

export const DEFAULT_POLICY: Readonly<Policy> = {
  reserveEnergy: 300,
  targetEnergy: 1000,
  maxRemoteRooms: 0,
  allies: [],
  attackTargets: [],
};

export function validatePolicy(input: unknown): { policy: Policy; issues: string[] } {
  const policy: Policy = { ...DEFAULT_POLICY, allies: [], attackTargets: [] };
  const issues: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { policy, issues: ['policy must be an object; defaults applied'] };
  }
  const values = input as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!(key in DEFAULT_POLICY)) issues.push(`unknown setting: ${key}`);
  }
  for (const key of ['reserveEnergy', 'targetEnergy', 'maxRemoteRooms'] as const) {
    const value = values[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      issues.push(`${key} must be a non-negative safe integer; default applied`);
    } else {
      policy[key] = value;
    }
  }
  for (const key of ['allies', 'attackTargets'] as const) {
    const value = values[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim().length > 0)) {
      issues.push(`${key} must contain non-empty usernames; default applied`);
    } else {
      policy[key] = [...new Set(value.map((item: string) => item.trim()))];
    }
  }
  if (policy.targetEnergy < policy.reserveEnergy) {
    policy.targetEnergy = policy.reserveEnergy;
    issues.push('targetEnergy raised to reserveEnergy; reserve preserved');
  }
  policy.attackTargets = policy.attackTargets.filter((name) => {
    if (!policy.allies.includes(name)) return true;
    issues.push(`attack target conflicts with ally: ${name}; target disabled`);
    return false;
  });
  return { policy, issues };
}

/** Unknown vision is a waiting condition, not evidence that a room was lost. */
export function roomReadiness(capabilities: Capabilities, roomName: string, policy: Policy): string[] {
  const room = capabilities.rooms[roomName];
  if (!room || room.visibility === 'unknown') return ['room visibility unknown'];
  const reasons: string[] = [];
  if (!room.owned) reasons.push('room not owned');
  if (!room.spawnCount) reasons.push('no owned spawn');
  if (room.energyCapacity === null || policy.reserveEnergy > room.energyCapacity) {
    reasons.push('spawn energy capacity below reserve target');
  }
  return reasons;
}
