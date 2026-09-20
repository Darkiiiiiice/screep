/**
 * M7-1 机动防御(守家单兵)的纯决策层:守卫孵化门与损失预算。
 * 武装入侵在场时守卫是第一顺位盈余支出(工人地板之后)——没有守卫,
 * 塔能耗尽后工人会被逐个清场,经济归零。
 */

export const GUARD_COST = 260;
/** 在场守卫 TTL 低于此线即提前孵继任(与 claimer 交接同式)。 */
export const GUARD_HANDOFF_TTL = 200;
/** 一次威胁期内最多折损守卫数:超过即劣势战场,停止添兵(§101 失败可以退出)。 */
export const GUARD_LOSS_BUDGET = 2;
/** 塔疗是全房生效的,退到 spawn 附近即可吃疗;0.3 以下撤离,由塔抬回再上。 */
export const GUARD_RETREAT_RATIO = 0.3;

export interface HostileSummary {
  /** ATTACK/RANGED_ATTACK 部件数;0 = 非武装(不触发守卫)。 */
  armed: number;
  hits: number;
}

export interface GuardSpawnNeedArgs {
  hostiles: readonly HostileSummary[];
  /** 本房在册守卫数。 */
  guards: number;
  /** 在册守卫最大 TTL;无守卫时 undefined。 */
  guardTtl?: number | undefined;
  capacity: number;
  energyAvailable: number;
  /** 本次威胁期已折损守卫数(威胁期内消失的在册者)。 */
  losses: number;
}

/**
 * 武装入侵在场且守卫链需要补员时返回 true。
 * 门序:无武装敌 → 无需求;损失预算尽 → 劣势不添兵;容量/能量不足 → 不开票;
 * 零守卫或交接 TTL 触发 → 补员。
 */
export function guardSpawnNeed(args: GuardSpawnNeedArgs): boolean {
  if (!args.hostiles.some((h) => h.armed > 0)) return false;
  if (args.losses >= GUARD_LOSS_BUDGET) return false;
  if (args.capacity < GUARD_COST || args.energyAvailable < GUARD_COST) return false;
  if (args.guards === 0) return true;
  return (args.guardTtl ?? Infinity) < GUARD_HANDOFF_TTL;
}
