import { towerTargets, type HostileInput } from '../domain/defense';
import { selectRepairTarget } from '../domain/maintenance';

declare global {
  interface Memory {
    defenseStats?: Record<string, { attacks: number; heals: number; lastHostile: number }>;
  }
}

const TOWER_ATTACK_COST = 10;
const TOWER_HEAL_COST = 10;
const TOWER_REPAIR_COST = 10;

/**
 * Tower defense: focus-fire the highest-threat hostile, heal the most damaged
 * own creep, otherwise contribute to critical structure repair. Tower energy is
 * committed only while targets exist — no idle firing. Survival-first: this runs
 * before logistics each tick and never consults creep labor.
 */
export function runDefense(room: Room): void {
  const towerEnergy = (tower: StructureTower) => tower.store.getUsedCapacity(RESOURCE_ENERGY);
  const towers = room.find(FIND_MY_STRUCTURES).filter((s): s is StructureTower =>
    s.structureType === STRUCTURE_TOWER);
  if (!towers.length) return;
  const stats = (Memory.defenseStats ??= {});

  const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
  const hostileInputs: HostileInput[] = hostileCreeps.map(c => ({
    id: c.id,
    hits: c.hits,
    damageParts: c.body.filter(p => p.type === ATTACK || p.type === RANGED_ATTACK || p.type === WORK).length,
    proximity: Math.max(
      ...room.find(FIND_MY_SPAWNS).map(s => Math.max(Math.abs(s.pos.x - c.pos.x), Math.abs(s.pos.y - c.pos.y))),
      0,
    ),
  }));
  const targets = towerTargets(towers.map(t => ({ id: t.id, energy: towerEnergy(t) })), hostileInputs);
  if (Game.time % 50 === 0) console.log(`[def] t=${Game.time} rcl=${room.controller?.level} towers=${towers.length} hostiles=${hostileCreeps.length} parts=${hostileInputs.map(h => h.damageParts).join('/')} towerE=${towers.map(t => t.store.getUsedCapacity(RESOURCE_ENERGY)).join(',')} targets=${targets.length}`);
  if (targets.length) {
    const focus = hostileCreeps.find(c => c.id === targets[0]);
    for (const tower of towers) {
      if (towerEnergy(tower) < TOWER_ATTACK_COST || !focus) continue;
      const ret = tower.attack(focus);
      if (Game.time % 50 === 0) console.log(`[def2] ret=${ret}`);
      if (ret === OK) {
        stats[tower.id] = { attacks: (stats[tower.id]?.attacks ?? 0) + 1, heals: stats[tower.id]?.heals ?? 0, lastHostile: Game.time };
      }
    }
    return;
  }

  // No hostiles: heal the worst-hurt own creep first, then chip in on repairs.
  const damagedOwn = room.find(FIND_MY_CREEPS)
    .filter(c => c.hits < c.hitsMax)
    .sort((a, b) => (a.hits / a.hitsMax) - (b.hits / b.hitsMax));
  for (const tower of towers) {
    if (towerEnergy(tower) < TOWER_HEAL_COST) continue;
    const patient = damagedOwn[0];
    if (patient) {
      if (tower.heal(patient) === OK) {
        stats[tower.id] = { attacks: stats[tower.id]?.attacks ?? 0, heals: (stats[tower.id]?.heals ?? 0) + 1, lastHostile: stats[tower.id]?.lastHostile ?? 0 };
        continue;
      }
    }
  }

  // Repair: single shared triage target so towers never fight over structures.
  // Walls/ramparts are excluded: they absorb repair energy without bound.
  const repairable = room.find(FIND_STRUCTURES)
    .filter(s => s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART && s.structureType !== STRUCTURE_CONTAINER)
    .map(s => s as Structure & { hits: number; hitsMax: number });
  const repair = selectRepairTarget(repairable.map(s => ({
    id: s.id, structureType: s.structureType, hits: s.hits, hitsMax: s.hitsMax, critical: true,
  })));
  if (!repair) return;
  const structure = repairable.find(s => s.id === repair.id);
  for (const tower of towers) {
    if (towerEnergy(tower) < TOWER_REPAIR_COST || !structure) continue;
    tower.repair(structure);
  }
}
