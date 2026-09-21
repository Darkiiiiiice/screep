import { chooseRecipe } from '../domain/labs';
import type { LabRecipe } from '../domain/labs';

/**
 * 反应驱动(M6-5):输入 lab 各持一种矿物、各 ≥5、距输出 lab 2 环内时
 * 调 runReaction。几何与持料前提由布局(labSite 簇形)与供料(mharvester
 * 顺路补给)保证;这里只做确定性点火:id 序前两只为输入,末只为输出。
 * 冷却由引擎 cooldown 把关(REACTION_TIME),无需自行节流。
 */
export function driveLabs(room: Room): void {
  const labs = room.find(FIND_MY_STRUCTURES)
    .filter((s): s is StructureLab => s.structureType === STRUCTURE_LAB)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (labs.length < 3) return;
  const [in1, in2, out] = labs;
  if (!in1 || !in2 || !out || out.cooldown > 0) return;
  const type1 = labMineral(in1);
  const type2 = labMineral(in2);
  if (!type1 || !type2 || type1 === type2) return;
  const table = REACTIONS as Record<string, Record<string, string>>;
  const product: string | undefined = table[type1]?.[type2] ?? table[type2]?.[type1];
  const outType = labMineral(out) as ResourceConstant | undefined;
  if (!product || (outType && outType !== product)) return;
  const rc = product as ResourceConstant;
  if ((out.store.getUsedCapacity(rc) ?? 0) + 5 > (out.store.getCapacity(rc) ?? 0)) return;
  if (!out.pos.inRangeTo(in1.pos, 2) || !out.pos.inRangeTo(in2.pos, 2)) return;
  out.runReaction(in1, in2);
}

/** lab 只许持一种矿物(引擎单资源语义);返回当前矿物或 undefined(空)。 */
export function labMineral(lab: StructureLab): string | undefined {
  const store = (lab.store ?? {}) as unknown as Record<string, number | undefined>;
  const keys = Object.keys(store).filter(k => k !== RESOURCE_ENERGY && (store[k] ?? 0) > 0);
  return keys.length ? keys[0] : undefined;
}

/** 反应当前应做的配方(供供料方对齐);无原料返回 null。 */
export function currentRecipe(stock: Readonly<Record<string, number>>): LabRecipe | undefined {
  return chooseRecipe({ stock });
}

/** terminal 库存快照(纯数据,喂 chooseRecipe);只含非零项。 */
export function terminalStock(terminal: StructureTerminal): Record<string, number> {
  const stock: Record<string, number> = {};
  const store = (terminal.store ?? {}) as unknown as Record<string, number | undefined>;
  for (const k of Object.keys(store)) {
    const v = store[k] ?? 0;
    if (v > 0) stock[k] = v;
  }
  return stock;
}
