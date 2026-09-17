/**
 * M4 侦察情报层(domain,纯决策,不读 Game)。
 *
 * PLAN §3.6:情报带时效与可信度;不把失去视野当作房间安全或目标消失。
 * PLAN §1:所有队列有界——情报条目数量封顶,逐出最旧;失败有界——
 * 不可达目标记黑名单,TTL 后才允许复探。
 *
 * 本层只回答几个问题:记什么(observe)、什么时候算过期(isStale)、
 * 下一个侦察目标(nextScoutTarget)、什么时候该孵 scout(shouldSpawnScout)、
 * 目标是否可达(isReachable)。引擎读写全部在 game/intel.ts。
 */

export interface SourceIntel { id: string; x: number; y: number }
export interface ControllerIntel { level: number; owner?: string | undefined; reserver?: string | undefined; reservationTicks?: number | undefined; upgradeBlockedTicks?: number | undefined }
export interface ThreatIntel { hostiles: number; armed: number; towers: number; keeperLairs: number }
export interface RoomIntel {
  observedAt: number;
  sources: SourceIntel[];
  threat: ThreatIntel;
  /** 房间无控制器时缺省(部分走廊房)。 */
  controller?: ControllerIntel | undefined;
  mineral?: string | undefined;
}
export interface ScoutMission { target?: string | undefined; home: string }
export interface IntelMemory {
  schema: 1;
  rooms: Record<string, RoomIntel>;
  /** 不可达目标 → 失败 tick;TTL 内不再作为侦察候选。 */
  unreachable?: Record<string, number>;
  /** 在飞 scout 任务台账:scout 失踪时据此判定目标不可达。 */
  missions?: Record<string, ScoutMission>;
 /** 最近一次 scout 死亡(含退役)的 tick,用于复活冷却。 */
 lastScoutDeathAt?: number;
 /** 最近一次预定者死亡的 tick,用于死亡冷却。 */
 lastClaimerDeathAt?: number;
 /** 在飞预定者名(失踪判定用)。 */
 claimerActive?: string;
 /** 最近一次远矿工人死亡的 tick,用于死亡冷却。 */
 lastPioneerDeathAt?: number;
 /** 在飞远矿工人名(失踪判定用)。 */
 pioneerActive?: string;
 /** 远矿工人累计送回家的能量(净收益核算,§3.9 验收)。 */
 pioneerDelivered?: number;
 /** 远矿目标评分快照(EVALUATE 产出,EVAL_TOP 条)。 */
 evaluation?: { tick: number; targets: { name: string; score: number; sources: number; distance: number }[] };
 /** home→各房跳数缓存(路由静态,不随时间失效)。 */
 distances?: Record<string, number>;
}

/** 重观测周期:超过即视为过期,需要补侦察。 */
export const INTEL_STALE = 1500;
/** 情报房间数上限(§1 队列有界),超出逐出最旧观测。 */
export const INTEL_CAP = 16;
/** scout 身体为裸 [MOVE]。 */
export const SCOUT_COST = 50;
/** 侦察是 M4 能力,前置条件是升级链路已验证(RCL2,PLAN §2 能力前置);RCL1 的每滴能量都属于 boot 经济。 */
export const SCOUT_MIN_RCL = 2;
/** 只在孵化满能时才考虑 scout——它是奢侈品,不得动用补员/建设/升级经费。 */
export const SCOUT_SPAWN_MIN_ENERGY = 300;
/** scout 死亡后的复活冷却,防止幻影房间等病理场景填命流血。 */
export const SCOUT_RESPAWN_DELAY = 100;
/** 单房常备 scout 数。 */
export const SCOUT_TARGET = 1;
/** 不可达黑名单时效:超时允许复探(封锁可能解除,PLAN §3.6 复核)。 */
export const UNREACHABLE_TTL = 5000;

export function isStale(intel: RoomIntel | undefined, now: number, horizon: number = INTEL_STALE): boolean {
  return !intel || now - intel.observedAt >= horizon;
}

/**
 * 已确认的活跃威胁:观测未过期且存在敌对单位/塔。
 * 失去视野不等于安全——过期的威胁记录由调用方按保守策略处理。
 */
export function threatActive(intel: RoomIntel | undefined, now: number, horizon: number = INTEL_STALE): boolean {
  return !isStale(intel, now, horizon) && (intel!.threat.armed > 0 || intel!.threat.towers > 0);
}

/**
 * 下一个侦察目标:从未观测过的优先(按名字字典序保证确定性),
 * 其次最旧观测。全部新鲜时返回 undefined(本轮无需侦察)。
 */
export function nextScoutTarget(candidates: readonly string[], rooms: Record<string, RoomIntel>, now: number): string | undefined {
  const stale = candidates.filter(name => isStale(rooms[name], now));
  if (!stale.length) return undefined;
  return stale.sort((a, b) => (rooms[a]?.observedAt ?? -1) - (rooms[b]?.observedAt ?? -1) || a.localeCompare(b))[0];
}

/**
 * scout 是奢侈品:工人有孵化需求、孵化未满能、上次死亡冷却未过,
 * 或房间尚在 boot 阶段(RCL<2)时让位。
 */
export function shouldSpawnScout(args: { scoutsAlive: number; targetAvailable: boolean; workerSpawnPending: boolean; energyAvailable: number; controllerLevel: number; now: number; lastScoutDeathAt?: number | undefined }): boolean {
  return args.scoutsAlive < SCOUT_TARGET && args.targetAvailable && !args.workerSpawnPending
    && args.controllerLevel >= SCOUT_MIN_RCL
    && args.energyAvailable >= SCOUT_SPAWN_MIN_ENERGY
    && args.now - (args.lastScoutDeathAt ?? -Infinity) >= SCOUT_RESPAWN_DELAY;
}

/** 超出容量时逐出最旧观测;情报只按数量封顶,不按时间删除(过期≠删除)。 */
export function pruneIntel(rooms: Record<string, RoomIntel>, cap: number = INTEL_CAP): void {
  const names = Object.keys(rooms);
  if (names.length <= cap) return;
  names.sort((a, b) => rooms[a]!.observedAt - rooms[b]!.observedAt || a.localeCompare(b));
  for (const name of names.slice(0, names.length - cap)) delete rooms[name];
}

/** scout 失踪/卡死且未观测目标 → 目标记为不可达;TTL 内不再选它。 */
export function markUnreachable(intel: IntelMemory, name: string, now: number): void {
  (intel.unreachable ??= {})[name] = now;
}

export function isReachable(intel: IntelMemory, name: string, now: number): boolean {
  const failed = intel.unreachable?.[name];
  return failed === undefined || now - failed >= UNREACHABLE_TTL;
}

/** 清理过期不可达记录,保持情报有界(§1)。 */
export function pruneUnreachable(intel: IntelMemory, now: number): void {
  if (!intel.unreachable) return;
  for (const [name, tick] of Object.entries(intel.unreachable)) {
    if (now - tick >= UNREACHABLE_TTL) delete intel.unreachable[name];
  }
}

/** 引擎房间快照 → 情报记录的可测纯映射。 */
export interface RoomSnapshot {
  name: string;
  now: number;
  sources: SourceIntel[];
  controller?: ControllerIntel | undefined;
  hostiles: { armed: number }[];
  towers: number;
  keeperLairs: number;
  mineral?: string | undefined;
}
export function observe(snap: RoomSnapshot): RoomIntel {
  const intel: RoomIntel = {
    observedAt: snap.now,
    sources: snap.sources.map(s => ({ id: s.id, x: s.x, y: s.y })),
    threat: {
      hostiles: snap.hostiles.length,
      armed: snap.hostiles.reduce((sum, h) => sum + h.armed, 0),
      towers: snap.towers,
      keeperLairs: snap.keeperLairs,
    },
  };
  if (snap.controller) intel.controller = { ...snap.controller };
  if (snap.mineral) intel.mineral = snap.mineral;
  return intel;
}

/** 远矿候选评分:单源 100 分制,距离每跳 -10;双源房(200)天然胜过一切近邻单源。 */
export interface RemoteCandidate { name: string; score: number; sources: number; distance: number }
/** 评估结果在 Memory 中的驻留上界(§1 队列有界)。 */
export const EVAL_TOP = 3;

/**
 * 远矿目标评分(§3.9 EVALUATE,纯):只用新鲜情报;已确认威胁、他人归属、
 * 他人预留的房间直接出局(§3.6 失去视野≠安全);无源房无价值。
 * 威胁 = 武装部件(ATTACK/RANGED/HEAL/WORK/CLAIM,观测时已计入 armed)或敌塔;
 * 无武装的过路斥候不构成威胁——线上实证(2026-09-17):把路人当入侵者会让
 * 预定者无限自杀循环,房间永远锁不住。
 * 我方自己的预定必须留在榜上——CLAIM 之后 DEPLOY 才找得到目标,
 * 否则预定一生效评估就把房间扔掉,流水线自我截断。
 * 评分 = sources×100 - distance×10,同分按名字字典序保证确定性。
 * 返回前 EVAL_TOP 名,空榜 = 暂无合格远矿房。
 */
export function evaluateRemoteTargets(args: { rooms: Record<string, RoomIntel>; distances: Record<string, number>; me: string; now: number }): RemoteCandidate[] {
  const candidates: RemoteCandidate[] = [];
  for (const [name, intel] of Object.entries(args.rooms)) {
    if (isStale(intel, args.now)) continue;
    if (intel.threat.armed > 0 || intel.threat.towers > 0) continue;
    if (intel.controller?.owner !== undefined) continue;
    if (intel.controller?.reserver !== undefined && intel.controller.reserver !== args.me && (intel.controller.reservationTicks ?? 0) > 0) continue;
    if (intel.sources.length === 0) continue;
    const distance = args.distances[name];
    if (distance === undefined) continue;
    candidates.push({ name, score: intel.sources.length * 100 - distance * 10, sources: intel.sources.length, distance });
  }
  return candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, EVAL_TOP);
}

/** 预定者身体 [CLAIM, MOVE] 造价。 */
export const CLAIMER_BODY_COST = 650;
/** 预定者也是满员工人口粮外的盈余:与矿工同地板。 */
export const CLAIMER_WORKER_FLOOR = 4;
/** 我方预定低于该余量即补刷(上限 5000,留足回程与波动)。 */
export const CLAIMER_RESERVE_REFRESH = 2000;
/** 预定者死亡冷却:650 的身体不许连续填坑(§1 失败有界)。 */
export const CLAIMER_DEATH_COOLDOWN = 500;
/** 交接提前量:现任 TTL 低于此值即孵继任者(旅行 ~150 + 孵化 ~6 + 余量),
 *  预留不断档——线上实证:寿终->冷却->补孵->飞行链每周期留 ~650 tick 真空,
 *  真空期 pioneer 读到"非我方预定"按规则自尽,白烧 400/具。 */
export const CLAIMER_HANDOFF_LEAD = 200;

/**
 * 预定者孵化决策(§3.9 CLAIM/RESERVE,纯):只在四重盈余下派出——
 * 容量/全额能量/工人地板/无工人在途补员——且目标须为评估榜首、
 * 情报新鲜、非我方有效预定(低于刷新线才补)、死亡冷却已过。
 * 在飞预定者挡孵化,但其 TTL 低于交接提前量时放行继任者(无缝交接,
 * 预留真空会让远矿工人按规则自尽)。返回目标房名或 null。
 */
export function claimerSpawnNeed(args: {
  intel: IntelMemory;
  workers: number;
  capacity: number;
  energyAvailable: number;
  claimerAlive: boolean;
  claimerTtl?: number | undefined;
  me: string;
  now: number;
}): string | null {
  if (args.capacity < CLAIMER_BODY_COST || args.energyAvailable < CLAIMER_BODY_COST) return null;
  if (args.workers < CLAIMER_WORKER_FLOOR) return null;
  if (args.claimerAlive && (args.claimerTtl ?? Infinity) >= CLAIMER_HANDOFF_LEAD) return null;
  if (args.intel.lastClaimerDeathAt !== undefined && args.now - args.intel.lastClaimerDeathAt < CLAIMER_DEATH_COOLDOWN) return null;
  const target = args.intel.evaluation?.targets[0]?.name;
  if (!target) return null;
  const room = args.intel.rooms[target];
  if (!room || isStale(room, args.now)) return null;
  const controller = room.controller;
  if (controller?.reserver === args.me && (controller.reservationTicks ?? 0) >= CLAIMER_RESERVE_REFRESH) return null;
  return target;
}

/** 远矿工人身体 [WORK×2, CARRY×2, MOVE×2] 造价:采满自运回母房。 */
export const PIONEER_BODY_COST = 400;
/** 与矿工/预定者同地板:远矿是满员工人口粮外的第三顺位盈余。 */
export const PIONEER_WORKER_FLOOR = 4;
/** 远矿工人死亡冷却(§1 失败有界)。 */
export const PIONEER_DEATH_COOLDOWN = 300;

/**
 * 远矿工人孵化决策(§3.9 DEPLOY,纯):榜首目标须为我方已预定(CLAIM 先行,
 * 流程顺序不许跳步)、情报新鲜;四重盈余门(容量/全额/工人地板/无在飞)
 * 与死亡冷却同源。每个目标只养一名远矿工人(v1 预算控制)。
 */
export function pioneerSpawnNeed(args: {
  intel: IntelMemory;
  workers: number;
  capacity: number;
  energyAvailable: number;
  pioneerAlive: boolean;
  me: string;
  now: number;
}): string | null {
  if (args.capacity < PIONEER_BODY_COST || args.energyAvailable < PIONEER_BODY_COST) return null;
  if (args.workers < PIONEER_WORKER_FLOOR || args.pioneerAlive) return null;
  if (args.intel.lastPioneerDeathAt !== undefined && args.now - args.intel.lastPioneerDeathAt < PIONEER_DEATH_COOLDOWN) return null;
  const target = args.intel.evaluation?.targets[0]?.name;
  if (!target) return null;
  const room = args.intel.rooms[target];
  if (!room || isStale(room, args.now) || room.sources.length === 0) return null;
  if (room.controller?.reserver !== args.me) return null;
  return target;
}
