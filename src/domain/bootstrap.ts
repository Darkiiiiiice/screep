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
  const target = Math.max(2, Math.min(6, input.sources * 2));
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
