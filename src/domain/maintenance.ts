export interface RepairableStructure {
  id: string;
  structureType: string;
  hits: number;
  hitsMax: number;
  critical: boolean;
}

export interface RepairSelection {
  id: string;
  ratio: number;
  urgent: boolean;
}

/** Below this ratio a structure enters the repair queue; walls are never passed in. */
export const REPAIR_THRESHOLD = 0.8;
/** Below this ratio repair preempts construction. */
export const URGENT_REPAIR_THRESHOLD = 0.25;

/**
 * Pick at most one repair target per room per tick.
 * Ordering: urgent first, then critical infrastructure, then lowest health,
 * then stable id order for determinism. Healthy structures are ignored so
 * normal decay windows do not steal workers from spawn/upgrade.
 */
export function selectRepairTarget(structures: RepairableStructure[]): RepairSelection | undefined {
  let best: RepairableStructure | undefined;
  let bestRatio = 0;
  let bestUrgent = false;
  for (const structure of structures) {
    if (!structure.id || structure.hitsMax <= 0) continue;
    if (structure.hits < 0 || structure.hits >= structure.hitsMax) continue;
    const ratio = structure.hits / structure.hitsMax;
    if (ratio >= REPAIR_THRESHOLD) continue;
    const urgent = ratio < URGENT_REPAIR_THRESHOLD;
    if (!best) {
      best = structure;
      bestRatio = ratio;
      bestUrgent = urgent;
      continue;
    }
    if (urgent !== bestUrgent) {
      if (urgent) {
        best = structure;
        bestRatio = ratio;
        bestUrgent = urgent;
      }
      continue;
    }
    if (structure.critical !== best.critical) {
      if (structure.critical) {
        best = structure;
        bestRatio = ratio;
        bestUrgent = urgent;
      }
      continue;
    }
    if (ratio < bestRatio || (ratio === bestRatio && structure.id < best.id)) {
      best = structure;
      bestRatio = ratio;
      bestUrgent = urgent;
    }
  }
  return best ? { id: best.id, ratio: bestRatio, urgent: bestUrgent } : undefined;
}
