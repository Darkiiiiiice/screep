export interface WorkerCapacity { ttl: number; spawning: boolean; work: number }
export interface PopulationInput {
  energy: number;
  capacity: number;
  sources: number;
  workers: WorkerCapacity[];
  travel: number;
  spawnBusy: boolean;
}

/** Small mobile generalists keep the entire recovery chain available to every worker. */
export function populationPlan(input: PopulationInput) {
  const affordable = Math.floor(input.energy / 200);
  const maximum = Math.max(1, Math.min(3, Math.floor(input.capacity / 200)));
  const productive = input.workers.filter(w => w.work > 0 && !w.spawning);
  const emergency = productive.length === 0;
  const imminentLoss = productive.length > 0 && productive.every(w => w.ttl < input.travel + 52);
  const units = emergency || imminentLoss ? Math.max(1, Math.min(maximum, affordable)) : maximum;
  const spawnTicks = units * 9;
  const lead = spawnTicks + input.travel + 25;
  // Workforce scales with room growth (PLAN §3.2 岗位建模): the M2 economy floor
  // (sources × 2) is the base; surplus spawn capacity (bigger bodies at higher
  // RCL) adds labor for build/upgrade/defense. The term depends on CAPACITY
  // (sustainable), never the oscillating store — target must not flicker with
  // spawn/haul cycles (PLAN §2.4 反抖动); affordability is gated at spawn time by
  // `affordable >= units`, not by shrinking the target.
  const target = Math.max(input.sources * 2, Math.min(12, input.sources * 2 + Math.floor(input.capacity / 300)));
  const future = input.workers.filter(w => w.spawning || w.ttl > lead).length;
  const needed = future < target;
  return {
    target, units, lead, cost: units * 200,
    spawn: !input.spawnBusy && needed && affordable >= units,
    reserve: needed ? units * 200 : 0,
    reason: emergency ? 'restore-income' : needed ? 'replacement-or-growth' : 'upgrade-surplus',
    // Fraction of one spawn consumed by steady-state replacement.
    spawnUtilization: target * spawnTicks / Math.max(1, 1500 - input.travel),
  };
}

/** 专职矿工身体:[WORK×5, CARRY, MOVE]=650——单源满采(10/tick)且带一格货架向脚下容器过货。 */
export const MINER_BODY_COST = 650;
/** 专职矿工的容量门槛:身体必须全额可付,低配房间继续用通用工兼任。 */
export const MINER_MIN_CAPACITY = MINER_BODY_COST;
/** 工人地板:矿工不搬运,至少留 2 搬运 + 升级/维修余量才许孵矿工。 */
export const MINER_WORKER_FLOOR = 4;

export interface MinerSourceState { id: string; hasContainer: boolean; minerAlive: boolean }

/**
 * 专职矿工补员决策(纯):源旁容器已就位且无在役矿工(含孵化中)时,
 * 从盈余能量孵一只 5-WORK 矿工顶替兼任。工人补员优先——矿工是盈余支出,
 * 不得动用补员/恢复经费(与 scout 三门同源,PLAN §3.1 补员优先)。
 */
export function minerSpawnNeed(args: { capacity: number; energyAvailable: number; workerCount: number; workerSpawnPending: boolean; sources: readonly MinerSourceState[] }): string | undefined {
  if (args.capacity < MINER_MIN_CAPACITY || args.energyAvailable < MINER_BODY_COST) return undefined;
  if (args.workerCount < MINER_WORKER_FLOOR || args.workerSpawnPending) return undefined;
  return args.sources.filter(s => s.hasContainer && !s.minerAlive).map(s => s.id).sort()[0];
}

export interface ProgressState { x: number; y: number; energy: number; unchanged: number }
export function trackProgress(previous: ProgressState | undefined, x: number, y: number, energy: number): ProgressState {
  return { x, y, energy, unchanged: previous?.x === x && previous.y === y && previous.energy === energy ? previous.unchanged + 1 : 0 };
}

export function retryDelay(attempts: number): number {
  return Math.min(200, 25 * 2 ** Math.min(3, Math.max(0, attempts - 3)));
}

export function energyBudget(capacity: number, reserve: number, target: number, replacement: number) {
  const floor = Math.min(capacity, Math.max(reserve, replacement));
  return { reserve: floor, target: Math.min(capacity, Math.max(floor, target)) };
}
