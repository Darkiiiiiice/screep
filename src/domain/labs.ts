/**
 * 反应链决策(M6-5,纯):双基础矿物配方表 + 按 terminal 库存选配方。
 * 单矿房间(矿只有一种)无反应可做——第二输入等市场(M6-6)或种子补给,
 * 决策层对"原料不齐"的正确行为是返回 null,而不是烧掉单一库存。
 */

/** 配方只收双基础输入(无中间品依赖,供应链最短);顺序即优先级。 */
export const LAB_RECIPES: ReadonlyArray<{ inputs: readonly [string, string]; out: string }> = [
  { inputs: ['H', 'O'], out: 'OH' },
  { inputs: ['U', 'H'], out: 'UH' },
  { inputs: ['U', 'O'], out: 'UO' },
  { inputs: ['L', 'H'], out: 'LH' },
  { inputs: ['L', 'O'], out: 'LO' },
  { inputs: ['K', 'H'], out: 'KH' },
  { inputs: ['K', 'O'], out: 'KO' },
  { inputs: ['Z', 'H'], out: 'ZH' },
  { inputs: ['Z', 'O'], out: 'ZO' },
  { inputs: ['Z', 'K'], out: 'G' },
];

/** terminal 里每种输入低于此量不开炉(保底,免得把库存抽干)。 */
export const LAB_INPUT_FLOOR = 40;
/** terminal 里产物高于此量停炉(产能过剩即停,库存换市场在 M6-6)。 */
export const LAB_OUTPUT_CAP = 1000;

export interface LabRecipe { inputs: readonly [string, string]; out: string }

/**
 * 按 terminal 库存选当前配方:第一张"双输入都够、产物未过剩"的表。
 * 确定性——表序即优先级,同状态必同选。
 */
export function chooseRecipe(args: { stock: Readonly<Record<string, number>> }): LabRecipe | undefined {
  for (const recipe of LAB_RECIPES) {
    const [a, b] = recipe.inputs;
    if ((args.stock[a] ?? 0) >= LAB_INPUT_FLOOR && (args.stock[b] ?? 0) >= LAB_INPUT_FLOOR
      && (args.stock[recipe.out] ?? 0) < LAB_OUTPUT_CAP) {
      return recipe;
    }
  }
  return undefined;
}

/** 输入 lab 低于此量即触发补料(与 LAB_REACTION_AMOUNT=5 同量级,留余量)。 */
export const LAB_INPUT_LACK = 50;
