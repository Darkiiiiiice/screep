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
  return !isStale(intel, now, horizon) && (intel!.threat.hostiles > 0 || intel!.threat.towers > 0);
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
