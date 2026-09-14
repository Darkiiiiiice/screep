export interface TaskDependency { id: string; dependsOn: string[]; priority: number; lastProgress: number; retries: number }
export interface RecoveryDecision { executable: string[]; blocked: string[]; cycles: string[][]; release: string[] }

export type EconomicTaskKind = 'harvest' | 'haul' | 'spawn' | 'build' | 'upgrade';
export interface EconomicTask extends TaskDependency { kind: EconomicTaskKind; emergency?: boolean; fallbackReady?: boolean }
export interface EconomicPlan { tasks: EconomicTask[]; decision: RecoveryDecision; emergency: string[] }

export function planEconomicTasks(tasks: EconomicTask[], now: number, waitLimit = 200): EconomicPlan {
  const decision = recoverDependencies(tasks, now, waitLimit);
  // A fallback must have independently verified prerequisites. Merely naming a
  // task "harvest" cannot make missing workers or an inaccessible source available.
  const emergency = tasks.filter(task => task.emergency && task.fallbackReady).map(task => task.id);
  const recovered = tasks.map(task => emergency.includes(task.id) ? { ...task, dependsOn: [] } : task);
  return { tasks: recovered, decision: emergency.length ? recoverDependencies(recovered, now, waitLimit) : decision, emergency };
}

/** Dependencies refer to unfinished tasks. Missing prerequisites are unknown, not complete.
 * Reachability is bounded by the active graph; mutually reachable nodes form one cycle.
 */
export function recoverDependencies(tasks: TaskDependency[], now: number, waitLimit = 200): RecoveryDecision {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const reachable = new Map<string, Set<string>>();
  for (const task of tasks) {
    const seen = new Set<string>(); const pending = [...task.dependsOn];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(byId.get(id)?.dependsOn ?? []));
    }
    reachable.set(task.id, seen);
  }
  const cycles: string[][] = []; const grouped = new Set<string>();
  for (const task of tasks) {
    if (grouped.has(task.id) || !reachable.get(task.id)!.has(task.id)) continue;
    const cycle = tasks.filter(other => reachable.get(task.id)!.has(other.id) && reachable.get(other.id)!.has(task.id)).map(other => other.id);
    cycles.push(cycle);
    for (const id of cycle) grouped.add(id);
  }
  const executable = tasks.filter(task => task.dependsOn.length === 0)
    .sort((a, b) => (b.priority + Math.floor(Math.max(0, now - b.lastProgress) / waitLimit)) - (a.priority + Math.floor(Math.max(0, now - a.lastProgress) / waitLimit)) || a.id.localeCompare(b.id)).map(task => task.id);
  const blocked = tasks.filter(task => task.dependsOn.length > 0).map(task => task.id);
  const release = tasks.filter(task => grouped.has(task.id) || task.dependsOn.length > 0 && now - task.lastProgress >= waitLimit).map(task => task.id);
  return { executable, blocked, cycles, release };
}
