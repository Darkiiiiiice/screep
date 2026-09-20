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
  evaluateColonizeTargets,
  evaluateRemoteTargets,
  isReachable,
  isStale,
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
    /** 预定者目标房名(§3.9 CLAIM/RESERVE)。 */
    claimTarget?: string;
    /** 远程机组目标房名(§3.9 DEPLOY)。 */
    remoteTarget?: string;
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

/** 评估节奏:情报变化远慢于 tick,每 25 tick 重算一次足够。 */
export const EVAL_INTERVAL = 25;

/**
 * 远矿目标评分(§3.9 EVALUATE):findRoute 跳数喂给纯决策,结果驻留
 * Memory.intel.evaluation 供后续 CLAIM/RESERVE/DEPLOY 切片消费。
 * 本切片只产出决策记录,不孵任何远矿单位。
 */
export function runEvaluation(home: string): void {
  if (Game.time % EVAL_INTERVAL !== 0) return;
  const intel = intelState();
  const distances = intel.distances ??= {};
  for (const name of Object.keys(intel.rooms)) {
    if (distances[name] !== undefined) continue;
    const route = Game.map.findRoute(home, name);
    if (route !== ERR_NO_PATH) distances[name] = route.length;
  }
  const me = Game.rooms[home]?.controller?.owner?.username;
  if (!me) return;
  intel.evaluation = { tick: Game.time, targets: evaluateRemoteTargets({ rooms: intel.rooms, distances, me, now: Game.time }) };
  // M5:同节奏产殖民榜——纯决策记录,不孵单位;空榜如实驻留(§1 失败有界,
  // 无可占目标时 colonizer 门禁自然无目标可锁)。
  intel.colonization = { tick: Game.time, targets: evaluateColonizeTargets({ rooms: intel.rooms, distances, me, now: Game.time }) };
}

/**
 * 每 tick 驱动预定者(与 scout 同为全局单位):目标失效(威胁/被他人预定/
 * 情报过期)即退役触发冷却;在目标房内顺手重观测,保持评估情报常新——
 * 否则情报过期会让已预定房间掉出评估,预定断档。
 */
export function driveClaimers(allies: readonly string[], cpuLimit: number): void {
  const intel = intelState();
  for (const creep of Object.values(Game.creeps)) {
    const mem = creep.memory;
    if (mem.role !== 'claimer' || creep.spawning) continue;
    if (Game.cpu.getUsed() >= cpuLimit) break;
    const target = mem.claimTarget;
    const room = target ? intel.rooms[target] : undefined;
    // 退役判据用武装而非人头:无武装过路斥候不配让我们放弃一个已预定的房
    // (线上实证:hostiles 判据导致 claimer 见到路人就自杀,650 一具白烧)。
    const invalid = !target || !room || isStale(room, Game.time)
      || room.threat.armed > 0
      || (room.controller?.reserver !== undefined && room.controller.reserver !== creep.owner.username);
    if (invalid) {
      creep.suicide();
      continue;
    }
    if (creep.room.name !== target) {
      try {
        // 与 scout 同式:range 22 跨房导航 + reusePath;寻路抛错按不可达退役。
        creep.moveTo(new RoomPosition(25, 25, target), { range: 22, reusePath: 20 });
      } catch {
        markUnreachable(intel, target, Game.time);
        creep.suicide();
      }
      continue;
    }
    intel.rooms[target] = observeRoom(creep.room, allies);
    const controller = creep.room.controller;
    if (!controller) continue;
    if (creep.pos.isNearTo(controller)) creep.reserveController(controller);
    else creep.moveTo(controller);
  }
  // 继任者优先:有任何 claimer 在册(含孵化中),指针直接移交——重叠交接期
  // 长老寿终不得触发死亡冷却,否则 500 冷却会白白冻结下一次交接(线上实证)。
  const active = Object.values(Game.creeps).find(c => c.memory.role === 'claimer');
  if (active) {
    intel.claimerActive = active.name;
  } else if (intel.claimerActive && !Object.values(Game.creeps).some(c => c.name === intel.claimerActive)) {
    // 全员尽没才算死亡事件。死亡探针:名字后缀即孵化 tick,记录享年。
    const born = Number(intel.claimerActive.split('-').pop());
    if (Number.isFinite(born)) intel.lastClaimerDeathAge = Game.time - born;
    intel.lastClaimerDeathAt = Game.time;
    delete intel.claimerActive;
  }
}

/** 远程搬运工离家交付的最低载货量:半空就跑长途会把运力烧在路上。 */
const REMOTE_HAUL_MIN_LOAD = 150;

/** 机组送达入口:孵化/扩展优先,容器兜底;送达量计入 remoteDelivered。 */
function deliverRemote(intel: IntelMemory, creep: Creep): void {
  const sinks = creep.room.find(FIND_STRUCTURES).filter((s): s is StructureSpawn | StructureExtension | StructureContainer =>
    (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_CONTAINER)
    && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
  const sink = creep.pos.findClosestByRange(sinks);
  if (!sink) return;
  if (creep.pos.isNearTo(sink)) {
    const carried = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    if (creep.transfer(sink, RESOURCE_ENERGY) === OK) intel.remoteDelivered = (intel.remoteDelivered ?? 0) + Math.min(carried, sink.store.getFreeCapacity(RESOURCE_ENERGY));
  } else creep.moveTo(sink);
}

/**
 * 每 tick 驱动远程机组(全局单位,§3.9 DEPLOY 的经济梯队):
 * - 矿工:蹲目标房源点开采,采满即脚下掉落(drop-miner),永不搬运;
 * - 搬运工:在目标房捡最大的掉落能量堆,满载回母房喂孵化/容器体系。
 * 威胁(武装)到达即在远撤离回母房保命,情报复位自动复工;目标失效(过期/
 * 不再是我方预定)送完手上货后退役。送达量计入 remoteDelivered,
 * 供"远矿净收益为正"的验收核算。
 */
export function driveRemoteMining(cpuLimit: number): void {
  const intel = intelState();
  const crew = Object.values(Game.creeps).filter(c => c.memory.role === 'remoteMiner' || c.memory.role === 'remoteHauler');
  // 死亡判定在行动循环外(全量计数,不吃 CPU 门):计数下降即记冷却。
  // 同 tick 死亡+补员完成会掩盖一次——可接受,下一具死亡仍会触发(§1 失败有界)。
  const minersAlive = crew.filter(c => c.memory.role === 'remoteMiner' && !c.spawning).length;
  const haulersAlive = crew.filter(c => c.memory.role === 'remoteHauler' && !c.spawning).length;
  const prev = intel.remoteCrew ?? { miners: 0, haulers: 0 };
  if (prev.miners > minersAlive) intel.lastRemoteMinerDeathAt = Game.time;
  if (prev.haulers > haulersAlive) intel.lastRemoteHaulerDeathAt = Game.time;
  intel.remoteCrew = { miners: minersAlive, haulers: haulersAlive };
  for (const creep of crew) {
    if (creep.spawning) continue;
    if (Game.cpu.getUsed() >= cpuLimit) break;
    const mem = creep.memory;
    const target = mem.remoteTarget;
    const home = mem.home ??= creep.room.name;
    const room = target ? intel.rooms[target] : undefined;
    const hostile = room ? room.threat.armed > 0 : false;
    // 退役判据:情报过期(claimer 链彻底断裂)或房间被【别人】预定/占领才退役。
    // 预定断档(reserver=undefined)不算数:claimer 冷却+飞行的几百 tick 里预定
    // 必然归零,若此时机组自杀,每个换班周期都白烧 1200+ 重组(线上二次实证
    // 2026-09-18);断档期机组原地继续干,新 claimer 到岗即恢复,过期兜底仍由
    // isStale 承担。
    const reserver = room?.controller?.reserver;
    const invalid = !target || !room || isStale(room, Game.time)
      || (reserver !== undefined && reserver !== creep.owner.username);

    // 入侵撤离:在远遇敌立刻回母房;威胁消除(情报刷新)后自动复工。
    if (hostile && creep.room.name === target) {
      creep.say('🚨');
      creep.moveTo(new RoomPosition(25, 25, home), { range: 22, reusePath: 20 });
      continue;
    }
    if (invalid) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && creep.room.name !== home) {
        creep.moveTo(new RoomPosition(25, 25, home), { range: 22, reusePath: 20 });
      } else {
        creep.suicide();
      }
      continue;
    }

    if (mem.role === 'remoteMiner') {
      if (creep.room.name !== target) {
        // 直奔情报里记下的源点;寻路抛错 = 目标不可达,黑名单并退役。
        const src = room.sources[0];
        if (!src) { creep.suicide(); continue; }
        try {
          creep.moveTo(new RoomPosition(src.x, src.y, target), { range: 1, reusePath: 20 });
        } catch {
          markUnreachable(intel, target, Game.time);
          creep.suicide();
        }
        continue;
      }
      const source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
      if (!source) continue;
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        if (creep.pos.isNearTo(source)) creep.harvest(source);
        else creep.moveTo(source);
      } else {
        creep.drop(RESOURCE_ENERGY);
      }
      continue;
    }

    // 搬运工:满载即回母房交付;在目标房捡最大掉落堆,堆空且够起运线就返程,
    // 空手则守源旁等矿工产出。
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      if (creep.room.name !== home) creep.moveTo(new RoomPosition(25, 25, home), { range: 22, reusePath: 20 });
      else deliverRemote(intel, creep);
      continue;
    }
    if (creep.room.name !== target) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) >= REMOTE_HAUL_MIN_LOAD && creep.room.name === home) { deliverRemote(intel, creep); continue; }
      try {
        creep.moveTo(new RoomPosition(25, 25, target), { range: 22, reusePath: 20 });
      } catch {
        markUnreachable(intel, target, Game.time);
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) creep.suicide();
      }
      continue;
    }
    const piles = creep.room.find(FIND_DROPPED_RESOURCES).filter(r => r.resourceType === RESOURCE_ENERGY && r.amount > 0);
    if (piles.length) {
      const pile = piles.sort((a, b) => b.amount - a.amount)[0]!;
      if (creep.pos.isNearTo(pile)) creep.pickup(pile);
      else creep.moveTo(pile);
      continue;
    }
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) >= REMOTE_HAUL_MIN_LOAD) {
      creep.moveTo(new RoomPosition(25, 25, home), { range: 22, reusePath: 20 });
      continue;
    }
    const src = room.sources[0];
    if (src) creep.moveTo(new RoomPosition(src.x, src.y, target), { range: 2, reusePath: 20 });
  }
}
