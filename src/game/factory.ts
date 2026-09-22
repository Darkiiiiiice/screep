import { chooseCommodity, factoryStock } from '../domain/factory';

/**
 * 压条驱动(M6-7):冷却由引擎 cooldown 把关,决策只在
 * "矿+能量够、产物未过剩"时点火 produce。bar 无 level 门槛,
 * 组件消耗/产出全部由引擎结算(处理器侧直接落库)。
 */
export function driveFactory(room: Room): void {
  const factory = room.find(FIND_MY_STRUCTURES).find((s): s is StructureFactory => s.structureType === STRUCTURE_FACTORY);
  if (!factory || factory.cooldown > 0) return;
  const commodity = chooseCommodity({ stock: factoryStock(factory.store) });
  if (commodity) factory.produce(commodity.bar as CommoditiesTypes);
}
