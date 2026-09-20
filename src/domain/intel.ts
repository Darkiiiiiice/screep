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
  /** 上一位 claimer 享年(死亡探针,诊断换班链断裂原因)。 */
  lastClaimerDeathAge?: number;
 /** 在飞预定者名(失踪判定用)。 */
 claimerActive?: string;
 /** 最近一次远程矿工/搬运工死亡的 tick,用于各自的死亡冷却。 */
 lastRemoteMinerDeathAt?: number;
 lastRemoteHaulerDeathAt?: number;
 /** 远程机组存活快照(矿工/搬运工各自计数),驱动循环据此判定死亡。 */
 remoteCrew?: { miners: number; haulers: number };
 /** 远程机组累计送回家的能量(净收益核算,§3.9 验收;前身 pioneerDelivered 见台账)。 */
 remoteDelivered?: number;
 /** 远矿目标评分快照(EVALUATE 产出,EVAL_TOP 条)。 */
 evaluation?: { tick: number; targets: { name: string; score: number; sources: number; distance: number }[] };
 /** 殖民目标评分快照(M5,与远矿同节奏产出;空榜 = 情报范围内暂无可占房)。 */
 colonization?: { tick: number; targets: RemoteCandidate[] };
 /** 在飞殖民者名(失踪判定用,M5)。 */
 colonizerActive?: string;
 /** 最近一次殖民者死亡的 tick(M5 死亡冷却)。 */
 lastColonizerDeathAt?: number;
 /** 已占领殖民地台账:房名 → 占领/落成/灭队记录(M5-3 启动队消费令箭;
  * spawnedAt 落地即毕业交还本地循环;lastSquadCount 驱动灭队判定)。 */
 colonies?: Record<string, { claimedAt: number; spawnedAt?: number; lastPioneerWipeAt?: number; lastSquadCount?: number }>;
 /** 评估根房间:距离缓存全是根相对的,首评锚定,根房失守才重锚并清缓存
  * (否则殖民房入环后以殖民房为原点重算,双榜混入两套距离)。 */
 rootRoom?: string;
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

/**
 * 殖民目标评分(M5,纯):比远矿更严——
 * 有任何归属(owner 不论敌我)出局;任何仍在生效的外援预定出局
 * (claimController 对有效预定无效;余量按情报年龄折算,衰减归零即解锁,
 * 与 claimer 门禁同一折算教训);武装/塔/无源/过期/无路由同远矿口径。
 * 我方自己的预定不挡(自占自的预定合法,且 CLAIM 先行正是扩张前奏)。
 * 评分与远矿同刻度;本函数只产决策记录,孵化门槛(GCL/CPU)在 colonizer 门禁。
 */
export function evaluateColonizeTargets(args: { rooms: Record<string, RoomIntel>; distances: Record<string, number>; me: string; now: number }): RemoteCandidate[] {
  const candidates: RemoteCandidate[] = [];
  for (const [name, intel] of Object.entries(args.rooms)) {
    if (isStale(intel, args.now)) continue;
    if (intel.threat.armed > 0 || intel.threat.towers > 0) continue;
    const controller = intel.controller;
    if (!controller || controller.owner !== undefined) continue;
    if (controller.reserver !== undefined && controller.reserver !== args.me) {
      const effectiveTicks = (controller.reservationTicks ?? 0) - Math.max(0, args.now - intel.observedAt);
      if (effectiveTicks > 0) continue;
    }
    if (intel.sources.length === 0) continue;
    const distance = args.distances[name];
    if (distance === undefined) continue;
    candidates.push({ name, score: intel.sources.length * 100 - distance * 10, sources: intel.sources.length, distance });
  }
  return candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, EVAL_TOP);
}

/** 殖民者身体 [CLAIM, MOVE] 造价(与预定者同构,任务是一次性 claim)。 */
export const COLONIZER_BODY_COST = 650;
/** 与预定者同地板:殖民是满员工人口粮外的盈余支出。 */
export const COLONIZER_WORKER_FLOOR = 4;
/** 殖民者死亡冷却(§1 失败有界):须远小于 CLAIM 件寿命 600,同预定者教训。 */
export const COLONIZER_DEATH_COOLDOWN = 150;

/**
 * 殖民者孵化决策(M5,纯):五重门——
 * **GCL 空额**(gclFreeSlots≤0 直接拒:名额不足时不浪费派兵,验收原文;
 * 线上实证 2026-09-20 GCL1=99126 分,下一名额在 1e6)/容量/全额 650/
 * 工人地板 4/无在飞(占领是一次性事件,不搞重叠交接)+ 死亡冷却。
 * 目标锁殖民榜榜首且情报须新鲜:过期情报不派兵(§3.6 失去视野≠安全)。
 * 返回目标房名或 null。
 */
export function colonizerSpawnNeed(args: {
  intel: IntelMemory;
  workers: number;
  capacity: number;
  energyAvailable: number;
  colonizerAlive: boolean;
  gclFreeSlots: number;
  now: number;
}): string | null {
  if (args.gclFreeSlots <= 0) return null;
  if (args.capacity < COLONIZER_BODY_COST || args.energyAvailable < COLONIZER_BODY_COST) return null;
  if (args.workers < COLONIZER_WORKER_FLOOR) return null;
  if (args.colonizerAlive) return null;
  if (args.intel.lastColonizerDeathAt !== undefined && args.now - args.intel.lastColonizerDeathAt < COLONIZER_DEATH_COOLDOWN) return null;
  const target = args.intel.colonization?.targets[0]?.name;
  if (!target) return null;
  const room = args.intel.rooms[target];
  if (!room || isStale(room, args.now)) return null;
  return target;
}

/** 预定者身体 [CLAIM, MOVE] 造价。 */
export const CLAIMER_BODY_COST = 650;
/** 预定者也是满员工人口粮外的盈余:与矿工同地板。 */
export const CLAIMER_WORKER_FLOOR = 4;
/** 我方预定低于该余量即补刷(上限 5000,留足回程与波动)。 */
export const CLAIMER_RESERVE_REFRESH = 2000;
/** 预定者死亡冷却:防 650 连续填坑(§1 失败有界)。须远小于 CLAIM 件寿命
 * 600(CREEP_CLAIM_LIFE_TIME):冷却是链覆盖率的分母,500 冷却会把覆盖率
 * 压到 ~50% 以下,预定周期性断档(线上实证 2026-09-18)。 */
export const CLAIMER_DEATH_COOLDOWN = 150;
/** 交接提前量:现任 TTL 低于此值即孵继任者(旅行 ~150 + 孵化 ~6 + 攒 650 余量),
 * 预留不断档——线上实证:寿终->冷却->补孵->飞行链每周期留 ~650 tick 真空,
 * 真空期远矿工人读到"非我方预定"按规则自尽,白烧 400/具。
 * 2026-09-18 二次实证:机组 TTL 同为 1500,换班挤兑期矿工重孵(550)先把能量
 * 抽干,200 窗口攒不齐 650 仍断档;翻倍到 400 让攒钱先于挤兑开始。 */
export const CLAIMER_HANDOFF_LEAD = 400;

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
  // 情报是快照:余量须按观测年龄折算(线上实证:直接信快照会把链睡死——
  // 读数 2441 时真实已跌破刷新线,isStale 后彻底堵死,全靠 scout 兜底重启)。
  const effectiveTicks = (controller?.reservationTicks ?? 0) - Math.max(0, args.now - room.observedAt);
  if (controller?.reserver === args.me && effectiveTicks >= CLAIMER_RESERVE_REFRESH) return null;
  return target;
}

/** 远程矿工身体 [WORK×5, CARRY, MOVE] 造价:蹲源开采,采满即脚下掉落。 */
export const REMOTE_MINER_BODY_COST = 550;
/** 远程搬运工身体 [CARRY×4, MOVE×4] 造价:平原全速(1:1),远房↔母房穿梭。 */
export const REMOTE_HAULER_BODY_COST = 400;
/** 每名远程矿工配属的搬运工数(v1 预算:矿工 5/tick,搬运 ~0.95/tick/只,堆不下的
 *  盈余在源旁积压不掉耐久,后续容量上来再补运力)。 */
export const REMOTE_HAULERS_PER_MINER = 3;
/** 与矿工/预定者同地板:远矿是满员工人口粮外的盈余。 */
export const REMOTE_WORKER_FLOOR = 4;
/** 远程机组死亡冷却(§1 失败有界),矿工与搬运工各自独立计。 */
export const REMOTE_DEATH_COOLDOWN = 300;

/** 远程机组目标校验(纯):榜首、新鲜、我方已预定(CLAIM 先行,不许跳步)。 */
function remoteTarget(args: { intel: IntelMemory; me: string; now: number }): string | null {
 const target = args.intel.evaluation?.targets[0]?.name;
 if (!target) return null;
 const room = args.intel.rooms[target];
 if (!room || isStale(room, args.now)) return null;
 if (room.controller?.reserver !== args.me) return null;
 return target;
}

/**
 * 远程矿工孵化决策(§3.9 DEPLOY,纯):四重盈余门(容量/全额/工人地板/无在飞)
 * 与死亡冷却同源。每个目标只养一名蹲坑矿工(v1 预算控制)。
 */
export function remoteMinerSpawnNeed(args: {
 intel: IntelMemory;
 workers: number;
 capacity: number;
 energyAvailable: number;
 minerAlive: boolean;
 me: string;
 now: number;
}): string | null {
 if (args.capacity < REMOTE_MINER_BODY_COST || args.energyAvailable < REMOTE_MINER_BODY_COST) return null;
 if (args.workers < REMOTE_WORKER_FLOOR || args.minerAlive) return null;
 if (args.intel.lastRemoteMinerDeathAt !== undefined && args.now - args.intel.lastRemoteMinerDeathAt < REMOTE_DEATH_COOLDOWN) return null;
 return remoteTarget(args);
}

/**
 * 远程搬运工孵化决策(纯):矿工在岗才配运力(无产不运),数量上限
 * REMOTE_HAULERS_PER_MINER×在矿工数;盈余门与死亡冷却与矿工同源。
 */
export function remoteHaulerSpawnNeed(args: {
 intel: IntelMemory;
 workers: number;
 capacity: number;
 energyAvailable: number;
 haulers: number;
 miners: number;
 me: string;
 now: number;
}): string | null {
 if (args.capacity < REMOTE_HAULER_BODY_COST || args.energyAvailable < REMOTE_HAULER_BODY_COST) return null;
 if (args.workers < REMOTE_WORKER_FLOOR) return null;
 if (args.miners < 1 || args.haulers >= args.miners * REMOTE_HAULERS_PER_MINER) return null;
 if (args.intel.lastRemoteHaulerDeathAt !== undefined && args.now - args.intel.lastRemoteHaulerDeathAt < REMOTE_DEATH_COOLDOWN) return null;
 return remoteTarget(args);
}

/** 启动队(pioneer)身体 [WORK, CARRY, MOVE] 造价:自采自建的殖民先遣。 */
export const PIONEER_BODY_COST = 200;
/** 单殖民地启动队规模上限:建造/喂蛋/升级的最小自足单元,超编纯属烧钱。 */
export const PIONEER_SQUAD_SIZE = 3;
/** 与殖民者同地板:扩张是满员工人口粮外的盈余支出(§3.1 补员优先)。 */
export const PIONEER_WORKER_FLOOR = 4;
/** 启动队全灭冷却(§1 失败有界):灭队说明殖民地当前守不住或路不通。 */
export const PIONEER_WIPE_COOLDOWN = 300;

/**
 * 启动队孵化决策(M5-3,纯):以殖民台账为令箭——已占领、spawn 未落成
 * (spawnedAt 未记)、我方仍归属、情报新鲜、无武装威胁、路由可达、灭队冷却
 * 已过的殖民地,按房名字典序补到 SQUAD_SIZE。情报快照判据与殖民榜同口径;
 * 失去视野/归属丢失不填人(§3.6 失去视野≠安全)。返回目标房名或 null。
 */
export function pioneerSpawnNeed(args: {
  intel: IntelMemory;
  workers: number;
  capacity: number;
  energyAvailable: number;
  pioneers: Record<string, number>;
  me: string;
  now: number;
}): string | null {
  if (args.capacity < PIONEER_BODY_COST || args.energyAvailable < PIONEER_BODY_COST) return null;
  if (args.workers < PIONEER_WORKER_FLOOR) return null;
  for (const [name, colony] of Object.entries(args.intel.colonies ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (colony.spawnedAt !== undefined) continue;
    if (colony.lastPioneerWipeAt !== undefined && args.now - colony.lastPioneerWipeAt < PIONEER_WIPE_COOLDOWN) continue;
    if (args.intel.unreachable?.[name] !== undefined) continue;
    const room = args.intel.rooms[name];
    if (!room || isStale(room, args.now)) continue;
    if (room.threat.armed > 0 || room.threat.towers > 0) continue;
    if (room.controller?.owner !== args.me) continue;
    if ((args.pioneers[name] ?? 0) >= PIONEER_SQUAD_SIZE) continue;
    return name;
  }
  return null;
}

/**
 * 评估根房间抉择(纯):根房仍在我手即维持(返回原根);首评或根房失守
 * (丢失/被夺)重锚到调用方并要求清空距离缓存——distances 全是根相对的,
 * 换根不清缓存会让双榜混入两套距离。
 */
export function resolveEvaluationRoot(root: string | undefined, home: string, rootOwned: boolean): { root: string; clear: boolean } {
  if (root !== undefined && rootOwned) return { root, clear: false };
  return { root: home, clear: root !== undefined };
}
