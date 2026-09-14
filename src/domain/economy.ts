import { planEconomicTasks, type EconomicPlan, type EconomicTask } from './dependencies';

export interface HaulerInput { name: string; carrying: boolean; waitingSince?: number | undefined; retries: number; shipment?: { to: string; expires: number; dependsOn?: string[]; waitingSince?: number } | undefined }
export interface SiteInput { id: string; needsEnergy: boolean; suppliers: string[] }
export interface SpawnInput { room: string; waiting: boolean; suppliers: string[] }
export interface UpgradeInput { room: string; worker: string }
export interface PriorTask { lastProgress: number }
export interface EconomyInput {
  now: number;
  haulers: HaulerInput[];
  sites: SiteInput[];
  spawn?: SpawnInput | undefined;
  upgrade?: UpgradeInput | undefined;
  prior?: Record<string, PriorTask> | undefined;
}

/** Bare names refer to haul tasks; ids containing ':' address other roles directly. */
const ref = (id: string) => (id.includes(':') ? id : `haul:${id}`);

export function buildEconomicTasks(input: EconomyInput): EconomicTask[] {
  const since = (id: string) => input.prior?.[id]?.lastProgress ?? input.now;
  const tasks: EconomicTask[] = input.haulers.map(hauler => ({
    id: `haul:${hauler.name}`, kind: 'haul', dependsOn: hauler.shipment?.dependsOn?.map(ref) ?? [],
    priority: hauler.carrying ? 10 : 5, lastProgress: hauler.waitingSince ?? input.now, retries: hauler.retries,
  }));
  for (const site of input.sites) tasks.push({
    id: `build:${site.id}`, kind: 'build', dependsOn: site.needsEnergy ? site.suppliers.map(ref) : [],
    priority: 4, lastProgress: since(`build:${site.id}`), retries: 0,
  });
  if (input.spawn) tasks.push({
    id: `spawn:${input.spawn.room}`, kind: 'spawn', dependsOn: input.spawn.waiting ? input.spawn.suppliers.map(ref) : [],
    priority: 9, lastProgress: since(`spawn:${input.spawn.room}`), retries: 0,
  });
  if (input.upgrade) tasks.push({ id: `upgrade:${input.upgrade.room}`, kind: 'upgrade', dependsOn: [], priority: 3, lastProgress: input.now, retries: 0 });
  return tasks;
}

export function planEconomy(input: EconomyInput, waitLimit = 100): EconomicPlan {
  return planEconomicTasks(buildEconomicTasks(input), input.now, waitLimit);
}
