import { towerTargets, type HostileInput } from '../domain/defense';
import { GUARD_RETREAT_RATIO, HEALER_RETREAT_RATIO } from '../domain/combat';
import { selectRepairTarget } from '../domain/maintenance';

declare global {
  interface Memory {
    defenseStats?: Record<string, { attacks: number; heals: number; lastHostile: number }>;
    /** 守卫损失台账:names 为上 tick 在册守卫,威胁期内消失即计阵亡。 */
    guardLoss?: Record<string, { count: number; since: number; names: string[] }>;
  }
}

const TOWER_ATTACK_COST = 10;
const TOWER_HEAL_COST = 10;
const TOWER_REPAIR_COST = 10;
/** Heal/repair hold this reserve back; attacks may always spend it all. */
const TOWER_DEFENSE_RESERVE = 100;

/** 威胁平静超过此时长且零损失即销账(威胁期结束)。 */
const GUARD_EPISODE_TAIL = 100;

const armedCount = (c: Creep) =>
  c.body.filter((p) => p.type === ATTACK || p.type === RANGED_ATTACK).length;

/**
 * Guard driver: engage the nearest armed hostile, retreat into tower-heal
 * range below GUARD_RETREAT_RATIO, fall back to spawn-side post when clear.
 * Also maintains the per-room loss ledger consumed by guardSpawnNeed
 * (losses bound re-spawning: an unwinnable fight stops burning 260-creep
 * bodies after GUARD_LOSS_BUDGET deaths).
 */
export function driveGuards(room: Room, allies: readonly string[] = []): void {
  const guards = Object.values(Game.creeps)
    .filter((c) => c.memory.role === 'guard' && c.room.name === room.name);
  const hostiles = room.find(FIND_HOSTILE_CREEPS)
    .filter((c) => !allies.includes(c.owner?.username ?? ''))
    .filter((c) => armedCount(c) > 0);
  const ledger = (Memory.guardLoss ??= {});
  const rec = ledger[room.name] ?? (ledger[room.name] = { count: 0, since: Game.time, names: [] });
  const alive = new Set(guards.map((g) => g.name));
  if (hostiles.length) {
    rec.count += rec.names.filter((n) => !alive.has(n)).length;
    rec.since = Game.time;
  } else if (rec.count === 0 && Game.time - rec.since > GUARD_EPISODE_TAIL) {
    delete ledger[room.name];
    return;
  }
  rec.names = guards.map((g) => g.name);

  const spawn = room.find(FIND_MY_SPAWNS)[0];
  for (const guard of guards) {
    if (guard.hits / guard.hitsMax < GUARD_RETREAT_RATIO && spawn) {
      guard.moveTo(spawn.pos, { range: 3, reusePath: 10 });
      continue;
    }
    const target = guard.pos.findClosestByRange(hostiles);
    if (target) {
      if (guard.pos.inRangeTo(target, 1)) guard.attack(target);
      else guard.moveTo(target.pos, { range: 1, reusePath: 10 });
    } else if (spawn && !guard.pos.inRangeTo(spawn.pos, 2)) {
      guard.moveTo(spawn.pos, { range: 2, reusePath: 20 });
    }
  }
}


/**
 * Healer driver (M7-2 守家小队): deterministic pairing (i-th healer → i-th
 * guard by name sort), follow the guard one tile behind (range 2), heal the
 * most damaged friendly in range (adjacent heal preferred), retreat earlier
 * than the guard (HEALER_RETREAT_RATIO) — the healer is the squad's sustain,
 * losing it first strips the guard's armor. Never seeks hostiles.
 */
export function driveHealers(room: Room, allies: readonly string[] = []): void {
  const healers = Object.values(Game.creeps)
    .filter((c) => c.memory.role === 'healer' && c.room.name === room.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!healers.length) return;
  const guards = Object.values(Game.creeps)
    .filter((c) => c.memory.role === 'guard' && c.room.name === room.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  const spawn = room.find(FIND_MY_SPAWNS)[0];

  for (let i = 0; i < healers.length; i++) {
    const healer = healers[i]!;
    if (healer.hits / healer.hitsMax < HEALER_RETREAT_RATIO && spawn) {
      healer.moveTo(spawn.pos, { range: 3, reusePath: 10 });
      continue;
    }
    const patient = Object.values(Game.creeps)
      // 伤员只认我方(c.my 已排除他人,盟友伤员不占我方治疗预算,§盟友豁免)。
      .filter((c) => c.my && !allies.includes(c.owner?.username ?? '') && c.room.name === room.name && c.hits < c.hitsMax)
      .sort((a, b) => a.hits / a.hitsMax - b.hits / b.hitsMax)[0];
    if (patient) {
      if (healer.pos.inRangeTo(patient, 1)) healer.heal(patient);
      else if (healer.pos.inRangeTo(patient, 3)) healer.rangedHeal(patient);
      else healer.moveTo(patient.pos, { range: 1, reusePath: 10 });
      continue;
    }
    const guard = guards[i % Math.max(1, guards.length)];
    if (guard && !healer.pos.inRangeTo(guard.pos, 2)) healer.moveTo(guard.pos, { range: 2, reusePath: 10 });
    else if (!guard && spawn && !healer.pos.inRangeTo(spawn.pos, 2)) healer.moveTo(spawn.pos, { range: 2, reusePath: 20 });
  }
}

/**
 * Tower defense: focus-fire the highest-threat hostile, heal the most damaged
 * own creep, otherwise contribute to critical structure repair. Tower energy is
 * committed only while targets exist — no idle firing. Survival-first: this runs
 * before logistics each tick and never consults creep labor.
 */
export function runDefense(room: Room, allies: readonly string[] = []): void {
  const towerEnergy = (tower: StructureTower) => tower.store.getUsedCapacity(RESOURCE_ENERGY);
  const towers = room.find(FIND_MY_STRUCTURES).filter((s): s is StructureTower =>
    s.structureType === STRUCTURE_TOWER);
  if (!towers.length) return;
  const stats = (Memory.defenseStats ??= {});

  const hostileCreeps = room.find(FIND_HOSTILE_CREEPS)
    .filter(c => !allies.includes(c.owner?.username ?? ''));
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
  if (targets.length) {
    const focus = hostileCreeps.find(c => c.id === targets[0]);
    for (const tower of towers) {
      if (towerEnergy(tower) < TOWER_ATTACK_COST || !focus) continue;
      if (tower.attack(focus) === OK) {
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
    if (towerEnergy(tower) - TOWER_DEFENSE_RESERVE < TOWER_HEAL_COST) continue;
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
    if (towerEnergy(tower) - TOWER_DEFENSE_RESERVE < TOWER_REPAIR_COST || !structure) continue;
    tower.repair(structure);
  }
}
