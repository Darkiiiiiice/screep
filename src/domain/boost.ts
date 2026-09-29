/**
 * 突袭强化(M7-7,纯):§3.8 "近战突击"前置——小队编成期到强化 lab 领
 * T1 战斗化合物再开拔。v1 只做突击手攻击强化(UH);医疗 LO/拆除 ZH/
 * 移动 ZO/远程 KO/坦克 GO 已留表,随围攻刀逐级解锁。
 * 引擎语义(boostCreep 包装层实证):不带 bodyPartsCount 时强化所有可被
 * 该化合物强化的未强化部件(BOOSTS[part][compound] 过滤);每件扣 lab
 * 矿 30 + lab 能 20;RCL<6 实验室不可用(ERR_RCL_NOT_ENOUGH)。
 */

import { LAB_INPUT_FLOOR, LAB_RECIPES, chooseRecipe } from './labs';
import type { LabRecipe } from './labs';
import { ASSAULTER_BODY_PARTS, DISMANTLER_BODY_PARTS, SUPPORT_BODY_PARTS } from './raid';

/** 每强化一件部件,lab 消耗的矿物/能量(引擎常量镜像,纯层算量用)。 */
export const BOOST_MINERAL_PER_PART = 30;
export const BOOST_ENERGY_PER_PART = 20;
/** 强化 lab 的能量填充上限:全套 3 突击手 9 件 × 20 = 180,留冗余到 300。
 * 反应不吃能量(引擎 run-reaction 实证:只扣矿)——按 lab 容量 2000 灌是
 * 纯沉没(输入 lab 910 能永久死钱实证),还白占集结窗口的搬运趟次。 */
export const LAB_BOOST_ENERGY_TARGET = 300;
/** 集结期等强化料的时限:超时即放弃强化开拔。强化是增益不是前提——
 * 任务级红线是集结超时 600(自最近 roster 增长),强化等待必须远小于它。 */
export const BOOST_WAIT_LIMIT = 300;

/** T1 战斗化合物 → 可强化部件(引擎 BOOSTS 表静态镜像;纯层禁引擎全局)。 */
// 引擎 BOOSTS 表口径(constants.js 实证):move 归 ZO 不归 LO;work 上
// UO=harvest、ZH=dismantle——表错一格会让需求算量与"未强化"判定同时歪。
const T1_BOOSTABLE: Readonly<Record<string, readonly string[]>> = {
  UH: ['attack'],
  LO: ['heal'],
  KO: ['ranged_attack'],
  UO: ['work'],
  GO: ['tough'],
  ZO: ['move'],
  ZH: ['work'],
};

/** 角色 → 领的化合物:突击手 UH(M7-7)、拆墙手 ZH(M7-8);医疗 LO 等随
 * 围攻刀扩表。 */
const ROLE_COMPOUNDS: Readonly<Record<string, string>> = { assaulter: 'UH', dismantler: 'ZH' };

export interface BoostLeg { compound: string; parts: number }

/**
 * 该成员还差多少强化(纯):按角色对化合物,数未强化的可强化部件。
 * 角色无表/已领满 → null(直接开拔)。
 */
export function squadBoostLeg(creep: { memory: { role?: string | undefined }; body: ReadonlyArray<{ type: string; boost?: string | number | undefined }> }): BoostLeg | null {
  const compound = ROLE_COMPOUNDS[creep.memory.role ?? ''];
  if (!compound) return null;
  const boostable = T1_BOOSTABLE[compound];
  if (!boostable) return null;
  const remaining = creep.body.filter((p) => !p.boost && boostable.includes(p.type)).length;
  return remaining > 0 ? { compound, parts: remaining } : null;
}

/**
 * 小队强化需求(纯):编成 → 化合物目标存量。数量 = 各角色身体里可被
 * 本角色化合物强化的部件数 × 30/件(与引擎 boostCreep 扣料口径一致:
 * UH 只吃 attack,LO 只吃 heal——身体里其他部件不进账)。
 * 键序固定(UH 先),供 chooseRecipeWithDemand 确定性消费。
 */
export function combatBoostDemand(plan: { attackers: number; healers: number; dismantlers?: number }): Record<string, number> {
  const demand: Record<string, number> = {};
  const add = (compound: string | undefined, body: readonly string[], count: number): void => {
    if (!compound || count <= 0) return;
    const per = body.filter((p) => T1_BOOSTABLE[compound]?.includes(p)).length * BOOST_MINERAL_PER_PART;
    if (per > 0) demand[compound] = (demand[compound] ?? 0) + per * count;
  };
  add(ROLE_COMPOUNDS.assaulter, ASSAULTER_BODY_PARTS, plan.attackers);
  add(ROLE_COMPOUNDS.medic, SUPPORT_BODY_PARTS, plan.healers);
  add(ROLE_COMPOUNDS.dismantler, DISMANTLER_BODY_PARTS, plan.dismantlers ?? 0);
  return demand;
}

/**
 * 强化优先配方(纯):任务在册且某化合物未达需求时,优先开它的炉
 * (强化料是任务时效料——集结窗口内产不出来就白编队);需求已满/无
 * 任务/原料不齐则回落通用表,行为与 M6-5 完全一致。
 */
export function chooseRecipeWithDemand(args: { stock: Readonly<Record<string, number>>; demand?: Readonly<Record<string, number>> }): LabRecipe | undefined {
  for (const [compound, target] of Object.entries(args.demand ?? {})) {
    if ((args.stock[compound] ?? 0) >= target) continue;
    const recipe = LAB_RECIPES.find((r) => r.out === compound);
    if (!recipe) continue;
    const [a, b] = recipe.inputs;
    if ((args.stock[a] ?? 0) >= LAB_INPUT_FLOOR && (args.stock[b] ?? 0) >= LAB_INPUT_FLOOR) return recipe;
  }
  return chooseRecipe({ stock: args.stock });
}

/**
 * 需求判据的库存视图(纯):terminal 快照 + 各 lab 对需求化合物的持仓合并。
 * 强化料只产在输出 lab、没有 courier 腿把它送进 terminal(M6-5 起的缺口),
 * 只拿 terminal 比"需求已满"会让落闸永不生效、任务期恒产到输入见底。
 */
export function stockWithLabHoldings(
  stock: Readonly<Record<string, number>>,
  holdings: ReadonlyArray<Readonly<Record<string, number>>>,
  compounds: readonly string[],
): Record<string, number> {
  const merged: Record<string, number> = { ...stock };
  for (const compound of compounds) {
    for (const holding of holdings) merged[compound] = (merged[compound] ?? 0) + (holding[compound] ?? 0);
  }
  return merged;
}
