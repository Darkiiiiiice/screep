/**
 * M7-6 突袭小队(纯决策层):§3.8 "自动产生候选目标,按收益/威胁/距离/
 * 敌方防御评分" + "先实现单兵与简单小队"。与 expedition.ts(拆预留,
 * 和平房)互补:本层处理【武装占房】——有价值房被武装外人蹲着,守家
 * 单兵够不着,唯一经济动作是编小队跨房清场。全部读数以普通对象传入,
 * 禁止引擎全局。
 *
 * v1 边界(§先简后繁):目标无塔(破塔是独立作战能力)、无房主(有主房
 * 是战争级,不做)、单小队在飞、清场即完成撤回解散。
 */

import { isStale } from './intel';
import type { IntelMemory, RoomIntel } from './intel';

/** 突袭兵身体 [ATTACK×3, MOVE×3] = 390:3 MOVE 平原全速不掉队,90 dps。 */
export const ASSAULTER_BODY_COST = 390;
/** 医疗兵身体沿用守家配方 [HEAL×2, MOVE×2] = 700(combat.ts HEALER_COST)。 */
export const SUPPORT_BODY_COST = 700;
/** 突袭兵身体部件(单一真相:bootstrap 孵化与强化算量共用)。 */
export const ASSAULTER_BODY_PARTS = ['attack', 'attack', 'attack', 'move', 'move', 'move'] as const;
/** 医疗兵身体部件(2×HEAL(250)+2×MOVE(50)=600)。 */
export const SUPPORT_BODY_PARTS = ['heal', 'heal', 'move', 'move'] as const;
/** 拆墙手身体(M7-8):[WORK×4, MOVE×4] = 600——dismantle 50/件/tick(引擎
 * DISMANTLE_POWER 实证),200/tick 裸拆、ZH 强化后 400/tick;4 MOVE 平原全速。 */
export const DISMANTLER_BODY_COST = 600;
/** 游骑身体(M7-9 远程拉扯):[RANGED_ATTACK×2,MOVE×2]=400——3 环内全额
 * 20/tick(引擎 rangedAttack 无距离衰减),KO 强化后 40;无近战件,风筝为生。 */
export const RANGER_BODY_COST = 400;
export const RANGER_BODY_PARTS = ['ranged_attack', 'ranged_attack', 'move', 'move'] as const;
export const DISMANTLER_BODY_PARTS = ['work', 'work', 'work', 'work', 'move', 'move', 'move', 'move'] as const;
/** 突袭是满员工人口粮之上的盈余支出:地板同其他盈余岗。 */
export const ASSAULT_WORKER_FLOOR = 4;
/** 过远的武装房不打:行军暴露与补给损耗失去经济意义。 */
export const ASSAULT_MAX_DISTANCE = 2;
/** 单小队攻击手上限(预算封顶,超编是烧钱)。 */
export const ASSAULT_MAX_ATTACKERS = 4;
/** 一次出击最多折损成员数:超过即误判了优势,撤退(§失败有界)。 */
export const ASSAULT_LOSS_BUDGET = 1;
/** 出击结束(完成或撤退)后的再出击冷却:防对打不动的房反复送兵。 */
export const ASSAULT_COOLDOWN = 500;
/** 集结时限:自最近一次 roster 增长起算(串行孵化+能量回填节奏 ~300/具),
 * 超时未齐即撤退(§不让整队无限等待已死亡成员);死亡成员由折损判据处理。 */
export const ASSAULT_MUSTER_TIMEOUT = 600;
/** 清场保持时长:armed==0 需连续保持这么久才算完成(敌人短暂消失/撤退
 * 不算胜利,§战后侦察确认成果)。 */
export const ASSAULT_CLEAR_HOLD = 25;
/** 任务总时长预算(§3.8 最长持续时间):自立队起算。startedAt 每次补员
 * 重置不能锚,deadline 立队定死;超时按撤退落台账(§失败有界)。 */
export const ASSAULT_MISSION_TIMEOUT = 3000;
/** 烂尾任务的评估排除时长:冷却 500 只挡节奏不挡目标——对拆不动的房
 * (300M 墙/不可达 spawn)"撤退→再锁→再送"每轮烧 ~3170,靠排除断。 */
export const ASSAULT_TIMEOUT_EXCLUDE = 10000;

/**
 * 围攻烂尾排除(纯,M7-8b 评审修订):带拆墙手的任务以撤退收档、敌建筑仍在、
 * 且武装曾清零(打不下来的是建筑不是人)→ 记排除期。锚必须挂终态观测:
 * 密封房里零战损,成员 TTL 到期的折损撤退(~1500t)永远抢在任务 deadline
 * (3000)前面,只挂 timeout 的排除对主场景是死代码;deadline 退为纯保险
 * (无折损的不可达空转循环才由它兜底)。武装未清过的败仗不排除——那是
 * 战力误判,评估可战胜闸自会涨;敌人也可能自行离开。
 */
export function assaultExclusionDue(state: { plan: { dismantlers: number }; withdrawReason?: string | undefined; clearedSince?: number | undefined }, structuresNow: number | undefined): boolean {
  return state.withdrawReason !== undefined && state.plan.dismantlers > 0
    && structuresNow !== undefined && structuresNow > 0 && state.clearedSince !== undefined;
}

export interface AssaultCandidate {
  name: string;
  distance: number;
  /** 观测到的武装部件总数(敌方防御规模)。 */
  armed: number;
  /** 敌建筑数(M7-8 围攻拆除目标池;>0 时编队带拆墙手)。 */
  structures: number;
}

/**
 * 突袭目标榜(纯):有武装蹲守的无主有价值房——威胁在场(与守家同口径,
 * 无武装过路者不算)、无塔、情报新鲜、有源、距离达标、可战胜(armed 留出
 * +1 编成余量)。按武装数升序(软柿子先打),同分名字字典序确定性。
 */
export function evaluateAssaultTargets(args: { rooms: Record<string, RoomIntel>; distances: Record<string, number>; now: number; excludedUntil?: Record<string, number> | undefined }): AssaultCandidate[] {
  const candidates: AssaultCandidate[] = [];
  for (const [name, intel] of Object.entries(args.rooms)) {
    if (isStale(intel, args.now)) continue;
    // 超时排除期(§3.8 时长预算):上次打不下撤退的房,期内不再上榜。
    if ((args.excludedUntil?.[name] ?? 0) > args.now) continue;
    if (intel.threat.armed <= 0) continue;
    // 可战胜闸:编成攻击手 = armed+1 封顶,armed 达上限即无局部优势,
    // 打不动只会烧成"折损撤退+冷却+再立队"死循环(§3.8 遇无法破防不持续送兵)。
    if (intel.threat.armed >= ASSAULT_MAX_ATTACKERS) continue;
    if (intel.threat.towers > 0) continue;
    if (intel.controller?.owner !== undefined) continue;
    if (intel.sources.length === 0) continue;
    const distance = args.distances[name];
    if (distance === undefined || distance > ASSAULT_MAX_DISTANCE) continue;
    candidates.push({ name, distance, armed: intel.threat.armed, structures: intel.threat.structures });
  }
  return candidates.sort((a, b) => a.armed - b.armed || a.name.localeCompare(b.name));
}

export interface AssaultSquadPlan {
  attackers: number;
  healers: number;
  /** 拆墙手(M7-8):目标房有敌建筑时带 1 具——无战力,清场后开工拆建筑,
   * 拆完才算任务完成(围攻语义);v1 单兵,多墙房留待围攻刀扩编。 */
  dismantlers: number;
  /** 游骑(M7-9):敌武装 ≥2 时带 1 具——3 环风筝输出,无近战件不贴身。 */
  rangers: number;
}

/**
 * 小队编成(纯):局部优势原则——攻击手 = 武装数 + 1(封顶 4),
 * 医疗 = ceil(攻击手/2)(守家 1:1 是单兵场景; away 小队 2:1 够用)。
 */
export function planAssaultSquad(armed: number, structures = 0): AssaultSquadPlan {
  const attackers = Math.min(Math.max(1, armed) + 1, ASSAULT_MAX_ATTACKERS);
  // 游骑只在敌人有真实反击规模时上:对 1 具散兵近战群殴足够,风筝位是
  // 纯增量输出(等速近战追不上直线后撤,3 环内白打);v1 单兵。
  return { attackers, healers: Math.ceil(attackers / 2), dismantlers: structures > 0 ? 1 : 0, rangers: armed >= 2 ? 1 : 0 };
}

/** 突袭阶段:集结(母房出口)→ 行军(跨房)→ 交战 → 撤退/完成。 */
export type AssaultPhase = 'muster' | 'travel' | 'engage' | 'withdraw' | 'done';

export interface AssaultState {
  phase: AssaultPhase;
  target: string;
  plan: AssaultSquadPlan;
  /** 各阶段在册成员名(.game 层维护,阶段机只读计数)。 */
  attackers: readonly string[];
  healers: readonly string[];
  dismantlers: readonly string[];
  rangers: readonly string[];
  /** 本次出击累计折损(含撤退路上阵亡)。 */
  losses: number;
  /** 任务总时长截止 tick(立队时定死,不随补员重置;§3.8 时长预算)。 */
  deadline?: number;
}

export interface AssaultObservation {
  /** 当前 tick(时长预算判据)。 */
  now: number;
  /** 全员已就位集结格(M7-9,§3.8 集结字面义:人到齐——名册齐只是数字,
   * 位置齐才开拔;否则整队在敌门格站桩等迟到的,白吃火力)。 */
  squadAssembled: boolean;
  /** 新鲜情报显示目标房武装已清零(完成判据)。 */
  threatCleared: boolean;
  /** 全员已进目标房(行军完成判据,.game 层按 room.name 计数)。 */
  squadInRoom: boolean;
  /** 全员强化已了结(已强化/已放弃/本无化合物;M7-7 开拔闸):满编只是
   * 人数到齐,不吃这闸会把强化腿整段跳过(探针实证 3 攻 0 强化开拔)。 */
  squadBoostResolved: boolean;
  /** 目标房敌建筑已清零(M7-8 围攻完成判据;无拆墙手编成的任务忽略)。 */
  structuresCleared: boolean;
}

export interface AssaultVerdict {
  phase: AssaultPhase;
  complete: boolean;
  withdrawReason?: 'losses' | 'crippled' | 'timeout' | undefined;
}

/**
 * 阶段机(纯):完成判据优先于撤退判据(清场了就不白撤);
 * 撤退判据两条:折损超预算(误判优势)、攻击手折半(打不动了)。
 * 医疗全灭但攻击手齐整时继续(守家实证:攻击手硬够时医疗只是续航)。
 */
export function advanceAssault(state: AssaultState, obs: AssaultObservation): AssaultVerdict {
  if (state.phase === 'done') return { phase: 'done', complete: true };
  const attackersAlive = state.attackers.length;
  const squadFielded = attackersAlive + state.healers.length;
  // 围攻完成(M7-8):带拆墙手的任务要连敌建筑一起拆完才算成——只清武装
  // 就撤等于给蹲守者留了重建的壳。
  if (obs.threatCleared && state.phase === 'engage'
    && (state.plan.dismantlers === 0 || obs.structuresCleared)) return { phase: 'done', complete: true };
  // 总时长超时(§3.8 预算):完成判据在上优先——压哨拆完仍算赢;到期一律
  // 撤退落台账,目标由接线层记排除期(打不下来的房不反复送兵)。
  if (state.deadline !== undefined && obs.now >= state.deadline) {
    return { phase: 'withdraw', complete: false, withdrawReason: 'timeout' };
  }
  // 撤退判据只在开拔后(travel/engage)生效:集结期队伍天然不满编,
  // "折半/折损"是战场状态,不是集合状态(§不让整队无限等待——集合期
  // 的超时由 .game 层集结时限另行把门)。
  if (state.phase !== 'muster') {
    // 全灭也必须产出终态:roster 清空 + 折损入账 → 撤退(接线层即收台账落
    // 冷却)——否则"单小队在飞"闸永久卡死,再立队永不发生。
    if (state.losses >= ASSAULT_LOSS_BUDGET) {
      return { phase: 'withdraw', complete: false, withdrawReason: 'losses' };
    }
    if (attackersAlive < Math.ceil(state.plan.attackers / 2) && squadFielded > 0) {
      return { phase: 'withdraw', complete: false, withdrawReason: 'crippled' };
    }
  }
  if (state.phase === 'muster' && attackersAlive >= state.plan.attackers && state.healers.length >= state.plan.healers
    && state.dismantlers.length >= state.plan.dismantlers && state.rangers.length >= state.plan.rangers
    && obs.squadAssembled && obs.squadBoostResolved) {
    return { phase: 'travel', complete: false };
  }
  if (state.phase === 'travel' && obs.squadInRoom) {
    return { phase: 'engage', complete: false };
  }
  return { phase: state.phase, complete: false };
}

/** 突袭孵化决策输入:在飞小队台账 + 存量计数(.game 层含 spawning 计)。 */
export interface AssaultSpawnNeedArgs {
  intel: IntelMemory;
  aliveAttackers: number;
  aliveHealers: number;
  aliveDismantlers: number;
  aliveRangers: number;
  workers: number;
  capacity: number;
  energyAvailable: number;
  now: number;
}

export interface AssaultSpawnNeed {
  role: 'assaulter' | 'medic' | 'dismantler' | 'ranger';
  target: string;
  bodyCost: number;
  /** 立队时的编成(仅首具返回;补员时在飞小队已有编成)。 */
  plan?: AssaultSquadPlan;
}

/**
 * 突袭补员(纯):冷却已过;无在飞小队时对榜首目标立队(先攻击手);
 * 有在飞小队时按编成缺口补员(攻击手优先,医疗垫后)。战争是最后
 * 顺位盈余:工人地板之后才轮到。返回下一具该孵的兵种与目标。
 */
export function assaultSpawnNeed(args: AssaultSpawnNeedArgs): AssaultSpawnNeed | null {
  const cooldownActive = args.intel.lastAssaultEndAt !== undefined
    && args.now - args.intel.lastAssaultEndAt < ASSAULT_COOLDOWN;
  if (cooldownActive) return null;
  if (args.workers < ASSAULT_WORKER_FLOOR) return null;
  const state = args.intel.assault;
  if (!state || state.phase === 'withdraw') {
    if (state) return null;
    const target = evaluateAssaultTargets({ rooms: args.intel.rooms, distances: args.intel.distances ?? {}, now: args.now, excludedUntil: args.intel.assaultExcludedUntil })[0];
    if (!target) return null;
    if (args.capacity < ASSAULTER_BODY_COST || args.energyAvailable < ASSAULTER_BODY_COST) return null;
    const plan = planAssaultSquad(target.armed, target.structures);
    return { role: 'assaulter', target: target.name, bodyCost: ASSAULTER_BODY_COST, plan };
  }
  const target = state.target;
  if (args.aliveAttackers < state.plan.attackers) {
    if (args.capacity < ASSAULTER_BODY_COST || args.energyAvailable < ASSAULTER_BODY_COST) return null;
    return { role: 'assaulter', target, bodyCost: ASSAULTER_BODY_COST };
  }
  if (args.aliveHealers < state.plan.healers) {
    if (args.capacity < SUPPORT_BODY_COST || args.energyAvailable < SUPPORT_BODY_COST) return null;
    return { role: 'medic', target, bodyCost: SUPPORT_BODY_COST };
  }
  // 拆墙手垫后(M7-8):它是任务目标但无战力——攻击/医疗齐了才轮到。
  if (args.aliveDismantlers < state.plan.dismantlers) {
    if (args.capacity < DISMANTLER_BODY_COST || args.energyAvailable < DISMANTLER_BODY_COST) return null;
    return { role: 'dismantler', target, bodyCost: DISMANTLER_BODY_COST };
  }
  // 游骑殿底(M7-9):纯增量输出位,战力链齐了才补。
  if (args.aliveRangers < state.plan.rangers) {
    if (args.capacity < RANGER_BODY_COST || args.energyAvailable < RANGER_BODY_COST) return null;
    return { role: 'ranger', target, bodyCost: RANGER_BODY_COST };
  }
  return null;
}
