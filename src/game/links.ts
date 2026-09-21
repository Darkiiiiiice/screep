import { linkTransfers, type LinkNode } from '../domain/links';

/**
 * Link 驱动(M6-2):源 link(切比雪夫距离 source ≤2)半仓即发中枢,中枢
 * 等搬运链取走(见 runLogistics 库存表)。角色静态、决策图单向——无回流环。
 * 布局放置属 M6-3(规划器),本驱动对任意合法 link 对生效。
 */
export function driveLinks(room: Room): void {
  const links = room.find(FIND_MY_STRUCTURES).filter((s): s is StructureLink =>
    s.structureType === STRUCTURE_LINK);
  if (links.length < 2) return;
  const sources = room.find(FIND_SOURCES);
  const nodes: LinkNode[] = links.map(l => ({
    id: l.id,
    energy: l.store.getUsedCapacity(RESOURCE_ENERGY),
    free: l.store.getFreeCapacity(RESOURCE_ENERGY),
    cooldown: l.cooldown ?? 0,
    role: sources.some(s => l.pos.inRangeTo(s.pos, 2)) ? 'source' : 'hub',
  }));
  for (const plan of linkTransfers(nodes)) {
    const from = Game.getObjectById(plan.from as Id<StructureLink>);
    const to = Game.getObjectById(plan.to as Id<StructureLink>);
    if (from && to) from.transferEnergy(to, plan.amount);
  }
}
