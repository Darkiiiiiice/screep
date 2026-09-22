/**
 * 压条决策(M6-7,纯):基础矿物 → bar(500 矿 + 200 能 → 100 条,冷却 20)。
 * bar 是唯一无 level 门槛的单室商品(深链需要 operate factory 加持,不碰);
 * 单矿房间至多一条可做——原料不齐返回 undefined,不烧错库存。
 * 全部读数以普通对象传入,禁止引擎全局。
 */

export interface BarCommodity { mineral: string; bar: string; mineralCost: number; energyCost: number; amount: number }

/** 矿物 → bar 商品表(与引擎 COMMODITIES 的 bar 项同式;表序即优先级)。 */
export const BAR_COMMODITIES: readonly BarCommodity[] = [
  { mineral: 'U', bar: 'utrium_bar', mineralCost: 500, energyCost: 200, amount: 100 },
  { mineral: 'L', bar: 'lemergium_bar', mineralCost: 500, energyCost: 200, amount: 100 },
  { mineral: 'Z', bar: 'zynthium_bar', mineralCost: 500, energyCost: 200, amount: 100 },
  { mineral: 'K', bar: 'keanium_bar', mineralCost: 500, energyCost: 200, amount: 100 },
];

/** 矿物低于此量不开炉(组件 500 + 余量,由 courier 持续回填)。 */
export const FACTORY_MINERAL_FLOOR = 600;
/** 能量低于此量不开炉(组件 200 + 余量)。 */
export const FACTORY_ENERGY_FLOOR = 400;
/** 条类库存高于此量停炉(产能过剩即停,市场腿在 M6-6)。 */
export const FACTORY_OUTPUT_CAP = 1000;

/**
 * 按 factory 库存选当前商品:第一种"矿与能量都够、产物未过剩"的 bar。
 * 确定性——表序即优先级(U→L→Z→K),同状态必同选。
 */
export function chooseCommodity(args: { stock: Readonly<Record<string, number>> }): BarCommodity | undefined {
  for (const commodity of BAR_COMMODITIES) {
    if ((args.stock[commodity.bar] ?? 0) >= FACTORY_OUTPUT_CAP) continue;
    if ((args.stock[commodity.mineral] ?? 0) < FACTORY_MINERAL_FLOOR) continue;
    if ((args.stock.energy ?? 0) < FACTORY_ENERGY_FLOOR) continue;
    return commodity;
  }
  return undefined;
}

/** factory 库存快照(纯数据,只含非零项)。 */
export function factoryStock(store: unknown): Record<string, number> {
  const stock: Record<string, number> = {};
  const raw = (store ?? {}) as Record<string, number | undefined>;
  for (const k of Object.keys(raw)) {
    const v = raw[k] ?? 0;
    if (v > 0) stock[k] = v;
  }
  return stock;
}
