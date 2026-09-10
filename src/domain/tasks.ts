/**
 * Task board: what work exists, and who holds it.
 *
 * A task is a unit of work with a lease. The lease is the whole point: a creep
 * can die mid-task, and nothing will call "release" on its behalf, so every
 * lease carries a deadline and the board must be reaped each tick against the
 * set of living creeps. Without that, one death permanently removes a task from
 * the pool and the colony quietly starves while looking busy.
 *
 * Lives in `Memory`, not the heap: leases must survive a runtime restart, and
 * this is bounded data (it does not scale with creep count the way per-creep
 * state would).
 *
 * Everything here is a pure function over an explicit board object, so the whole
 * lifecycle is testable without an engine.
 */
import type { Role } from './types';

/** What kind of work a task represents. */
export type TaskKind = 'harvest' | 'deliver' | 'upgrade' | 'build';

export interface Task {
  id: string;
  kind: TaskKind;
  /** Object the task acts on. */
  targetId: string;
  room: string;
  /**
   * Dedup key. The planner regenerates tasks from the snapshot every tick, so
   * without a stable key the board would multiply tasks each tick.
   */
  key: string;
  /** Creep holding the lease, or null when the task is free. */
  leasedBy: string | null;
  /** Tick after which an unrenewed lease is abandoned. */
  leasedUntil: number;
  /** Creation tick — the deterministic tie-break when priorities are equal. */
  created: number;
  /** Higher wins. Lets a starvation response outrank routine work. */
  priority: number;
  /** Role the planner intended for this task. */
  role: Role;
}

export interface TaskBoard {
  tasks: Record<string, Task>;
  /** Monotonic counter backing task ids, so ids stay stable and ordered. */
  nextId: number;
}

export function emptyBoard(): TaskBoard {
  return { tasks: {}, nextId: 1 };
}

/** Default lease length. Long enough to cross a room, short enough to recover. */
export const DEFAULT_LEASE_TICKS = 50;

export interface TaskSpec {
  kind: TaskKind;
  targetId: string;
  room: string;
  role: Role;
  priority?: number;
}

/**
 * Key identifying a task's *work*, independent of which creep holds it.
 *
 * Room is included so the same structure id in another room is a different job
 * (ids are globally unique in practice, but the key should not depend on that).
 */
export function taskKey(spec: Pick<TaskSpec, 'kind' | 'targetId' | 'room'>): string {
  return `${spec.kind}:${spec.room}:${spec.targetId}`;
}

/**
 * Add a task, or return the existing one for the same work.
 *
 * Idempotent by design: the planner runs every tick against a fresh snapshot and
 * would otherwise create a duplicate per tick.
 */
export function addTask(board: TaskBoard, spec: TaskSpec, now: number): Task {
  const key = taskKey(spec);

  for (const task of Object.values(board.tasks)) {
    if (task.key !== key) continue;
    // Priority may only rise. A re-add exists to keep the task present, not to
    // undo a change another producer made.
    if (spec.priority !== undefined && spec.priority > task.priority) {
      task.priority = spec.priority;
    }
    return task;
  }

  const task: Task = {
    id: `t${String(board.nextId)}`,
    kind: spec.kind,
    targetId: spec.targetId,
    room: spec.room,
    key,
    leasedBy: null,
    leasedUntil: 0,
    created: now,
    priority: spec.priority ?? 0,
    role: spec.role,
  };

  board.nextId += 1;
  board.tasks[task.id] = task;
  return task;
}

export interface LeaseOptions {
  /** Only consider tasks for these roles. */
  roles?: Role[];
  /** Skip tasks in rooms the creep cannot reach. */
  room?: string;
}

/**
 * Lease the best available task to a creep.
 *
 * Selection order is priority, then age, then id — all deterministic, so two
 * creeps never evaluate ties differently and the assignment is reproducible
 * when replaying a recorded snapshot.
 *
 * Returns null when the creep already holds a task or nothing matches.
 */
export function leaseTask(
  board: TaskBoard,
  creepName: string,
  options: LeaseOptions,
  now: number,
): Task | null {
  // One task per creep: a creep with a lease must finish or lose it first.
  //
  // Asking for work RENEWS the lease. Without this the deadline silently expired
  // out from under a creep that was working the whole time — the creep calls
  // this every tick, so its own request is the liveness proof the deadline is
  // meant to approximate. The deadline then only catches a creep that stopped
  // calling (stuck, or dead without its lease being reaped).
  for (const task of Object.values(board.tasks)) {
    if (task.leasedBy !== creepName) continue;
    task.leasedUntil = now + DEFAULT_LEASE_TICKS;
    return task;
  }

  let best: Task | null = null;

  for (const task of Object.values(board.tasks)) {
    if (task.leasedBy !== null) continue;
    if (options.roles && !options.roles.includes(task.role)) continue;
    if (options.room && task.room !== options.room) continue;

    if (best === null || isBetter(task, best)) best = task;
  }

  if (best === null) return null;

  best.leasedBy = creepName;
  best.leasedUntil = now + DEFAULT_LEASE_TICKS;
  return best;
}

/** Deterministic ordering: priority, then oldest, then id. */
function isBetter(candidate: Task, incumbent: Task): boolean {
  if (candidate.priority !== incumbent.priority) return candidate.priority > incumbent.priority;
  if (candidate.created !== incumbent.created) return candidate.created < incumbent.created;
  return candidate.id < incumbent.id;
}

/**
 * Free leases that have expired or whose holder no longer exists.
 *
 * Two separate causes, and both are needed:
 *   - the deadline passed (the creep is stuck, or the tick it died on is gone);
 *   - the holder is not in `living`, which catches a death immediately rather
 *     than waiting for the deadline.
 *
 * @returns how many leases were reclaimed, for the stats segment
 */
export function reapExpired(
  board: TaskBoard,
  now: number,
  living: Partial<Record<string, true>>,
): number {
  let reclaimed = 0;

  for (const task of Object.values(board.tasks)) {
    if (task.leasedBy === null) continue;

    const holderGone = living[task.leasedBy] !== true;
    const expired = now > task.leasedUntil;

    if (holderGone || expired) {
      task.leasedBy = null;
      task.leasedUntil = 0;
      reclaimed += 1;
    }
  }

  return reclaimed;
}

/**
 * Drop tasks whose targets no longer exist.
 *
 * A task pointing at a destroyed site or an empty source would otherwise be
 * leased forever and never complete.
 */
export function dropTasksForMissingTargets(
  board: TaskBoard,
  validTargets: Partial<Record<string, true>>,
): number {
  let dropped = 0;

  for (const task of Object.values(board.tasks)) {
    if (validTargets[task.targetId] === true) continue;
    delete board.tasks[task.id];
    dropped += 1;
  }

  return dropped;
}

/** Count tasks by lease state, for diagnostics. */
export function boardSummary(board: TaskBoard): { total: number; leased: number; free: number } {
  let leased = 0;
  let total = 0;

  for (const task of Object.values(board.tasks)) {
    total += 1;
    if (task.leasedBy !== null) leased += 1;
  }

  return { total, leased, free: total - leased };
}
