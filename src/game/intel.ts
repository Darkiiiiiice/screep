/**
 * M4 侦察情报层(engine 接线):scout 孵化决策、跨房移动、观测写回。
 *
 * PLAN §3.6:scout 自动探索邻房,记录归属/预留/资源/威胁/观测时间。
 * 纯决策在 domain/intel.ts;这里只做 Game/Memory 读写。
 *
 * scout 与工人隔离:裸 [MOVE] 身体天然被 bootstrap 的工人过滤器
 * (WORK+CARRY+MOVE) 排除,不会进入 work()/logistics 调度。
 *
 * 失败有界(§1):scout 可能卡死(交通/幻影房间)或整只消失
 * (跨房传送到不存在的房间)。missions 台账记录每个在飞 scout 的
 * 当前目标;每 tick 对账,失踪且带着目标的 → 目标进不可达黑名单,
 * TTL 内不再选派,避免无限填命循环。
 */
import {
  INTEL_CAP,
  INTEL_STALE,
  isReachable,
  markUnreachable,
  nextScoutTarget,
  observe,
  pruneIntel,
  pruneUnreachable,
  shouldSpawnScout,
  type IntelMemory,
  type RoomIntel,
} from '../domain/intel';

declare global {
  interface Memory { intel?: IntelMemory }
  interface CreepMemory {
    home?: string;
    target?: string | undefined;
    visited?: string[];
    lastX?: number;
    lastY?: number;
    lastRoom?: string;
    stuck?: number;
  }
}

/** 位置不动超过该 tick 数判定卡死,自杀换下一任(重试有界,§1)。 */
const SCOUT_STUCK_LIMIT = 40;

export function intelState(): IntelMemory {
  const intel = Memory.intel;
  if (intel === undefined) return (Memory.intel = { schema: 1, rooms: {} });
  if (intel.schema !== 1) {
    // 旧版本/异源残留(v1 时代遗物、外部脚本写入)无法迁移:
    // 整体重置而非逐 tick 抛错死锁(线上实证 2026-09-17:v1 残留 {} 卡死情报层)。
    console.log(`[M4] intel: reset legacy memory (schema ${String(intel.schema)})`);
    return (Memory.intel = { schema: 1, rooms: {} });
  }
  return intel;
}

export function countScouts(): number {
  let count = 0;
  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.role === 'scout') count++;
  }
  return count;
}

/** 邻房候选:地图出口静态可查,不占情报存储;不可达目标按黑名单剔除。 */
export function scoutCandidates(intel: IntelMemory, home: string): string[] {
  const exits = Game.map.describeExits(home);
  if (!exits) return [];
  return Object.values(exits).filter(name => isReachable(intel, name, Game.time));
}

/** 工人有孵化需求时 scout 让位(§3.1 补员优先)。 */
export function maybeSpawnScout(room: Room, spawns: StructureSpawn[], workerSpawnPending: boolean): void {
  const intel = intelState();
  const candidates = scoutCandidates(intel, room.name);
  const targetAvailable = nextScoutTarget(candidates, intel.rooms, Game.time) !== undefined;
  if (!shouldSpawnScout({ scoutsAlive: countScouts(), targetAvailable, workerSpawnPending, energyAvailable: room.energyAvailable, controllerLevel: room.controller?.level ?? 0, now: Game.time, lastScoutDeathAt: intel.lastScoutDeathAt })) return;
  const idle = spawns.find(s => !s.spawning);
  idle?.spawnCreep([MOVE], `scout-${room.name}-${Game.time}`, { memory: { role: 'scout', home: room.name, visited: [] } });
}

function observeRoom(room: Room, allies: readonly string[]): RoomIntel {
  const armedParts: BodyPartConstant[] = [ATTACK, RANGED_ATTACK, HEAL, WORK, CLAIM];
  const hostiles = room.find(FIND_HOSTILE_CREEPS).filter(c => !allies.includes(c.owner?.username ?? ''));
  const towers = room.find(FIND_HOSTILE_STRUCTURES).filter(s =>
    s.structureType === STRUCTURE_TOWER && !allies.includes(s.owner?.username ?? '')).length;
  const keeperLairs = room.find(FIND_STRUCTURES).filter(s => s.structureType === STRUCTURE_KEEPER_LAIR).length;
  const controller = room.controller;
  const mineral = room.find(FIND_MINERALS)[0];
  return observe({
    name: room.name,
    now: Game.time,
    sources: room.find(FIND_SOURCES).map(s => ({ id: s.id, x: s.pos.x, y: s.pos.y })),
    controller: controller ? {
      level: controller.level,
      owner: controller.owner?.username,
      reserver: controller.reservation?.username,
      reservationTicks: controller.reservation?.ticksToEnd,
      upgradeBlockedTicks: controller.upgradeBlocked || undefined,
    } : undefined,
    hostiles: hostiles.map(c => ({ armed: armedParts.reduce((sum, part) => sum + c.getActiveBodyparts(part), 0) })),
    towers,
    keeperLairs,
    mineral: mineral?.mineralType,
  });
}

/**
 * 每 tick 驱动全部 scout(不属于任何单房循环——scout 大多时间在别家房间)。
 * 到达即观测写回;巡完母房全部邻房后回母房自杀,下一任按过期节奏补。
 */
export function driveScouts(allies: readonly string[], cpuLimit: number): void {
  const intel = intelState();
  pruneUnreachable(intel, Game.time);
  const alive = new Set<string>();
  for (const creep of Object.values(Game.creeps)) {
    const mem = creep.memory;
    if (mem.role !== 'scout' || creep.spawning) continue;
    if (Game.cpu.getUsed() >= cpuLimit) break;
    alive.add(creep.name);
    const home = mem.home ?? creep.room.name;
    const visited = mem.visited ??= [];

    if (mem.lastRoom === creep.room.name && mem.lastX === creep.pos.x && mem.lastY === creep.pos.y) mem.stuck = (mem.stuck ?? 0) + 1;
    else mem.stuck = 0;
    mem.lastRoom = creep.room.name; mem.lastX = creep.pos.x; mem.lastY = creep.pos.y;
    if ((mem.stuck ?? 0) >= SCOUT_STUCK_LIMIT || creep.ticksToLive === 1) { creep.say('💀'); creep.suicide(); continue; }

    if (mem.target && creep.room.name === mem.target) {
      intel.rooms[creep.room.name] = observeRoom(creep.room, allies);
      pruneIntel(intel.rooms, INTEL_CAP);
      visited.push(mem.target);
      delete mem.target;
      creep.say('📡');
    }

    if (!mem.target) {
      const remaining = scoutCandidates(intel, home).filter(name => !visited.includes(name));
      mem.target = nextScoutTarget(remaining, intel.rooms, Game.time);
      if (!mem.target) {
        // 巡游完成(或本任寿命内情报已全部新鲜):回母房退役。
        if (creep.room.name === home) { creep.say('🏁'); creep.suicide(); continue; }
        creep.moveTo(new RoomPosition(25, 25, home), { range: 22, reusePath: 20 });
        continue;
      }
    }

    try {
      creep.moveTo(new RoomPosition(25, 25, mem.target), { range: 22, reusePath: 20 });
    } catch {
      // 寻路层抛错(如 mock 引擎地形缺失):按不可达处理,自杀换下一任。
      markUnreachable(intel, mem.target, Game.time);
      creep.suicide();
    }
  }

  // 任务台账对账:记录存活 scout 的当前目标;失踪且带目标的判不可达。
  const missions = intel.missions ??= {};
  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.role === 'scout' && !creep.spawning) {
      missions[creep.name] = { target: creep.memory.target, home: creep.memory.home ?? creep.room.name };
    }
  }
  for (const [name, mission] of Object.entries(missions)) {
    if (alive.has(name)) continue;
    intel.lastScoutDeathAt = Game.time;
    if (mission.target) markUnreachable(intel, mission.target, Game.time);
    delete missions[name];
  }
}

/** 观测新鲜度供后续 EVALUATE 切片使用;不在本切片消费。 */
export { INTEL_STALE };
