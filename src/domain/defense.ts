/** One hostile creep as the defense layer sees it: hurt and threat. */
export interface HostileInput {
  id: string;
  hits: number;
  /** Damage-capable body parts (ATTACK/RANGED_ATTACK/WORK), already counted. */
  damageParts: number;
  /** Chebyshev distance to the structure the tower protects (spawn/controller). */
  proximity: number;
}

export interface TowerInput {
  id: string;
  /** Tower energy; a tower needs 10 per attack. */
  energy: number;
}

/**
 * Rank hostiles for tower focus fire. threat = damage potential × closeness:
 * a full 20-part raider near the spawn outranks a dismantler across the room,
 * and a zero-damage scout is harassment, never a threat.
 */
export function threatScore(hostile: HostileInput): number {
  return hostile.damageParts * 300 + Math.max(0, 50 - hostile.proximity);
}

/** Ordered hostile ids: the focus target first, then remaining threats. */
export function towerTargets(towers: TowerInput[], hostiles: HostileInput[]): string[] {
  const ready = towers.filter(t => t.energy >= 10);
  if (!ready.length) return [];
  return hostiles
    .filter(h => h.hits > 0 && h.damageParts > 0)
    .sort((a, b) => threatScore(b) - threatScore(a) || a.id.localeCompare(b.id))
    .map(h => h.id);
}
