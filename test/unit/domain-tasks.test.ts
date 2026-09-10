import { describe, expect, it } from 'vitest';
import {
  addTask,
  boardSummary,
  DEFAULT_LEASE_TICKS,
  dropTasksForMissingTargets,
  emptyBoard,
  leaseTask,
  reapExpired,
  taskKey,
} from '@/domain/tasks';

const spec = (targetId: string, overrides: Partial<Parameters<typeof addTask>[1]> = {}) => ({
  kind: 'harvest' as const,
  targetId,
  room: 'W1N1',
  role: 'harvester' as const,
  ...overrides,
});

describe('task identity', () => {
  it('keys on the work, not on the task instance', () => {
    expect(taskKey({ kind: 'harvest', targetId: 'src1', room: 'W1N1' })).toBe(
      'harvest:W1N1:src1',
    );
    // Same work in a different room is a different job.
    expect(taskKey({ kind: 'harvest', targetId: 'src1', room: 'W2N2' })).not.toBe(
      taskKey({ kind: 'harvest', targetId: 'src1', room: 'W1N1' }),
    );
  });

  it('does not duplicate a task that the planner re-creates each tick', () => {
    // The planner runs every tick against a fresh snapshot. Without idempotent
    // adds the board would grow by one duplicate per task per tick, and CPU
    // spent scanning it would grow with it.
    const board = emptyBoard();
    for (let tick = 1; tick <= 20; tick += 1) addTask(board, spec('src1'), tick);

    expect(boardSummary(board).total).toBe(1);
  });

  it('raises priority so an urgent condition is not lost', () => {
    const board = emptyBoard();
    addTask(board, spec('ctrl', { priority: 0 }), 1);
    addTask(board, spec('ctrl', { priority: 10 }), 2);
    expect(Object.values(board.tasks)[0]?.priority).toBe(10);
  });
});

describe('leasing', () => {
  it('leases a task and marks it held', () => {
    const board = emptyBoard();
    const task = addTask(board, spec('src1'), 1);

    const leased = leaseTask(board, 'Bob', {}, 1);
    expect(leased?.id).toBe(task.id);
    expect(boardSummary(board)).toEqual({ total: 1, leased: 1, free: 0 });
  });

  it('never gives one task to two creeps', () => {
    // Two creeps walking to the same source is pure waste, and the second one
    // would find it drained.
    const board = emptyBoard();
    addTask(board, spec('src1'), 1);

    expect(leaseTask(board, 'Bob', {}, 1)).not.toBeNull();
    expect(leaseTask(board, 'Alice', {}, 1)).toBeNull();
  });

  it('never gives one creep two tasks', () => {
    const board = emptyBoard();
    addTask(board, spec('src1'), 1);
    addTask(board, spec('src2'), 1);

    const first = leaseTask(board, 'Bob', {}, 1);
    const second = leaseTask(board, 'Bob', {}, 1);
    expect(second?.id).toBe(first?.id);
    expect(boardSummary(board).leased).toBe(1);
  });

  it('filters by role so a hauler is not sent to build', () => {
    const board = emptyBoard();
    addTask(board, spec('site1', { kind: 'build', role: 'builder' }), 1);
    addTask(board, spec('src1'), 1);

    const leased = leaseTask(board, 'Bob', { roles: ['builder'] }, 1);
    expect(leased?.kind).toBe('build');
  });

  it('takes the highest priority first', () => {
    const board = emptyBoard();
    addTask(board, spec('ctrl', { priority: 10 }), 1);
    addTask(board, spec('src1', { priority: 0 }), 1);

    expect(leaseTask(board, 'Bob', {}, 1)?.targetId).toBe('ctrl');
  });

  it('does not reset a held task when the planner re-adds it each tick', () => {
    // The planner feeds the same spec every tick. Re-adding must be a no-op on
    // the live task: it must not create a second task, must not steal the lease,
    // and must not move the identity the holder is tracking.
    const board = emptyBoard();
    const first = addTask(board, spec('src1'), 1);
    leaseTask(board, 'Bob', {}, 1);

    for (let tick = 2; tick <= 40; tick += 1) {
      const again = addTask(board, spec('src1'), tick);
      expect(again.id).toBe(first.id);
    }

    expect(boardSummary(board)).toEqual({ total: 1, leased: 1, free: 0 });
    expect(board.tasks[first.id]?.leasedBy).toBe('Bob');
  });

  it('renews the lease of a creep that is still asking for work', () => {
    // The bug this pins: `leaseTask` used to return the held task WITHOUT
    // extending its deadline, so a creep that worked continuously still lost its
    // lease every DEFAULT_LEASE_TICKS. It only recovered because the next tick
    // re-leased the same task, which is churn — and with a second creep in the
    // room, work that was being done could be handed to someone else.
    const board = emptyBoard();
    addTask(board, spec('src1'), 1);

    const start = 1;
    leaseTask(board, 'Bob', {}, start);
    const firstDeadline = board.tasks['t1']?.leasedUntil ?? 0;

    // A creep asks for work every tick, as the colony does.
    const later = start + DEFAULT_LEASE_TICKS * 3;
    leaseTask(board, 'Bob', {}, later);

    const renewed = board.tasks['t1']?.leasedUntil ?? 0;
    expect(renewed).toBeGreaterThan(firstDeadline);
    expect(renewed).toBe(later + DEFAULT_LEASE_TICKS);
  });

  it('keeps an actively working creep leased indefinitely', () => {
    // The end-to-end consequence: as long as the creep keeps asking, no tick
    // should ever reclaim its lease, however long the work takes.
    const board = emptyBoard();
    addTask(board, spec('src1'), 1);
    leaseTask(board, 'Bob', {}, 1);

    let now = 1;
    for (let tick = 0; tick < 500; tick += 1) {
      now += 1;
      // Colony order: reap first, then the creep asks for work again.
      reapExpired(board, now, { Bob: true });
      leaseTask(board, 'Bob', {}, now);
    }

    expect(board.tasks['t1']?.leasedBy).toBe('Bob');
  });

  it('still reaps a lease whose holder stopped asking for work', () => {
    // The renewal must not defeat the deadline entirely: a creep that is stuck
    // and no longer requesting work has to lose the task so someone else can
    // take it.
    const board = emptyBoard();
    addTask(board, spec('src1'), 1);
    leaseTask(board, 'Bob', {}, 1);

    // No further leaseTask calls; time passes.
    const after = 1 + DEFAULT_LEASE_TICKS + 1;
    expect(reapExpired(board, after, { Bob: true })).toBe(1);
  });

  it('resolves ties deterministically so replay is reproducible', () => {
    // Two tasks with equal priority created on the same tick fall through to id,
    // which reflects insertion order — and insertion order is what the view
    // layer sorts, so live and replay agree. The contract is determinism, not
    // which particular task wins: replaying the same snapshot must always
    // produce the same intent sequence.
    const first = emptyBoard();
    addTask(first, spec('srcB'), 5);
    addTask(first, spec('srcA'), 5);

    const second = emptyBoard();
    addTask(second, spec('srcB'), 5);
    addTask(second, spec('srcA'), 5);

    const pickedA = leaseTask(first, 'Bob', {}, 5);
    const pickedB = leaseTask(second, 'Bob', {}, 5);

    expect(pickedA?.targetId).toBe(pickedB?.targetId);
    // Also deterministic across Creep iteration order or id shape.
    expect(pickedA?.id).toBe('t1');
  });

  it('prefers older work when priority is equal', () => {
    const board = emptyBoard();
    addTask(board, spec('newer'), 10);
    addTask(board, spec('older'), 1);

    expect(leaseTask(board, 'Bob', {}, 10)?.targetId).toBe('older');
  });

  it('sets a lease deadline', () => {
    const board = emptyBoard();
    addTask(board, spec('src1'), 1);
    const leased = leaseTask(board, 'Bob', {}, 100);
    expect(leased?.leasedUntil).toBe(100 + DEFAULT_LEASE_TICKS);
  });
});

describe('lease recovery', () => {
  it('reclaims a lease whose holder no longer exists', () => {
    // A creep can die mid-task and nothing calls release on its behalf. Without
    // this the task is stranded forever and the colony starves while looking
    // busy — the single most damaging failure mode in this file.
    const board = emptyBoard();
    addTask(board, spec('src1'), 1);
    leaseTask(board, 'Ghost', {}, 1);

    const reclaimed = reapExpired(board, 2, {});
    expect(reclaimed).toBe(1);
    expect(boardSummary(board).free).toBe(1);
  });

  it('keeps a lease held by a living creep before its deadline', () => {
    const board = emptyBoard();
    addTask(board, spec('src1'), 1);
    leaseTask(board, 'Bob', {}, 1);

    expect(reapExpired(board, 10, { Bob: true })).toBe(0);
    expect(boardSummary(board).leased).toBe(1);
  });

  it('reclaims an expired lease even while the holder lives', () => {
    // The creep may be stuck against a wall; the deadline is what stops one
    // creep from holding work it cannot finish.
    const board = emptyBoard();
    addTask(board, spec('src1'), 1);
    leaseTask(board, 'Bob', {}, 1);

    expect(reapExpired(board, 1 + DEFAULT_LEASE_TICKS + 1, { Bob: true })).toBe(1);
  });

});

describe('target validity', () => {
  it('drops tasks whose target no longer exists', () => {
    // A task pointing at a destroyed site would otherwise be leased forever and
    // never complete, pinning a creep to impossible work.
    const board = emptyBoard();
    addTask(board, spec('src1'), 1);
    addTask(board, spec('src2'), 1);

    const dropped = dropTasksForMissingTargets(board, { src1: true });
    expect(dropped).toBe(1);
    expect(boardSummary(board).total).toBe(1);
  });

  it('keeps tasks when every target is valid', () => {
    const board = emptyBoard();
    addTask(board, spec('src1'), 1);
    expect(dropTasksForMissingTargets(board, { src1: true })).toBe(0);
  });
});

