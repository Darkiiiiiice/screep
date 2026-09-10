import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { planTasks } from '@/domain/plan';
import { emptyBoard, leaseTask, boardSummary } from '@/domain/tasks';
import type { RoomView, SourceView, StoreView } from '@/domain/types';

let engine: FakeEngine | undefined;

beforeEach(() => {
  engine = installFakeEngine();
});

afterEach(() => {
  engine?.restore();
  engine = undefined;
});

function source(id: string, energy = 3000): SourceView {
  return { id, x: 24, y: 5, room: 'W1N1', energy, ticksToRegeneration: 0 };
}

function store(overrides: Partial<StoreView> = {}): StoreView {
  return {
    id: 'cont1',
    type: 'container',
    x: 20,
    y: 20,
    room: 'W1N1',
    energy: 0,
    energyCapacity: 2000,
    ...overrides,
  };
}

function room(overrides: Partial<RoomView> = {}): RoomView {
  return {
    name: 'W1N1',
    controller: {
      id: 'ctrl',
      x: 43,
      y: 17,
      level: 3,
      my: true,
      ticksToDowngrade: 20_000,
      progress: 0,
      progressTotal: 45_000,
    },
    spawns: [],
    sources: [source('src1')],
    stores: [store()],
    constructionSites: [],
    creeps: [],
    hostiles: [],
    ...overrides,
  };
}

describe('task planning is idempotent', () => {
  it('produces the same board on a repeated tick', () => {
    // The planner runs every tick against a fresh snapshot. If it were not
    // idempotent the board would grow by a duplicate per task per tick.
    const board = emptyBoard();
    const view = room();

    planTasks(board, view, 'ESTABLISHED', 1);
    const after1 = boardSummary(board).total;
    planTasks(board, view, 'ESTABLISHED', 2);
    planTasks(board, view, 'ESTABLISHED', 3);

    expect(boardSummary(board).total).toBe(after1);
    expect(after1).toBeGreaterThan(0);
  });

  it('never steals a lease on re-add', () => {
    const board = emptyBoard();
    planTasks(board, room(), 'ESTABLISHED', 1);
    leaseTask(board, 'Bob', {}, 1);

    planTasks(board, room(), 'ESTABLISHED', 2);

    expect(boardSummary(board).leased).toBe(1);
  });
});

describe('pruning work that stopped being useful', () => {
  it('removes a drained source from the board', () => {
    // The source still EXISTS, so an existence-only check would keep the task
    // forever and keep offering it to creeps that then find nothing to harvest.
    // Deriving the whole set is what removes it.
    const board = emptyBoard();
    planTasks(board, room(), 'ESTABLISHED', 1);
    expect(Object.values(board.tasks).some((t) => t.kind === 'harvest')).toBe(true);

    const result = planTasks(board, room({ sources: [source('src1', 0)] }), 'ESTABLISHED', 2);

    expect(result.pruned).toBe(1);
    expect(Object.values(board.tasks).some((t) => t.kind === 'harvest')).toBe(false);
    // Work that is still wanted survives: the controller is still upgradable and
    // the container still has room.
    expect(Object.values(board.tasks).some((t) => t.kind === 'upgrade')).toBe(true);
  });

  it('removes a filled delivery target', () => {
    const board = emptyBoard();
    planTasks(board, room(), 'ESTABLISHED', 1);
    const before = boardSummary(board).total;

    const result = planTasks(
      board,
      room({ stores: [store({ energy: 2000, energyCapacity: 2000 })] }),
      'ESTABLISHED',
      2,
    );

    expect(result.pruned).toBe(1);
    expect(boardSummary(board).total).toBe(before - 1);
  });

  it('removes a completed construction site', () => {
    const withSite = room({
      constructionSites: [
        { id: 'site1', x: 30, y: 30, room: 'W1N1', structureType: 'road', progress: 0, progressTotal: 100 },
      ],
    });
    const board = emptyBoard();
    planTasks(board, withSite, 'ESTABLISHED', 1);
    expect(boardSummary(board).total).toBeGreaterThan(0);

    const result = planTasks(board, room(), 'ESTABLISHED', 2);

    expect(result.pruned).toBe(1);
  });

  it('keeps planning the upgrade while hostiles are present', () => {
    // Deliberately UNGATED. The task used to be dropped under threat, which read
    // as a safety feature but changed nothing: `decideUpgrader` never reads its
    // task, so the creep upgraded anyway (measured — the controller kept
    // advancing with a hostile in the room). The threat response now lives in
    // `decideUpgrader`; asserting it here would be asserting the decorative
    // layer. See domain-roles.test.ts for the behavioural test.
    const board = emptyBoard();
    planTasks(board, room(), 'ESTABLISHED', 1);

    const hostile = room({ hostiles: [{ id: 'h1', x: 10, y: 10 }] });
    const result = planTasks(board, hostile, 'ESTABLISHED', 2);

    expect(result.pruned).toBe(0);
    expect(Object.values(board.tasks).some((t) => t.kind === 'upgrade')).toBe(true);
  });

  it('reports how much it pruned, for the stats line', () => {
    const board = emptyBoard();
    planTasks(board, room(), 'ESTABLISHED', 1);
    const noWork = planTasks(
      board,
      room({ sources: [source('src1', 0)], stores: [] }),
      'ESTABLISHED',
      2,
    );

    expect(noWork.pruned).toBeGreaterThan(0);
    expect(noWork.created).toBe(0);
  });

  it('leaves another room\'s tasks alone', () => {
    // The wanted-set describes one room, so pruning globally would delete every
    // other room's work — a bug that only appears once the colony has two rooms.
    const board = emptyBoard();
    const here = room();
    const there: RoomView = {
      ...room(),
      name: 'W2N2',
      sources: [source('src2')],
      stores: [],
      controller: {
        id: 'ctrl2',
        x: 43,
        y: 17,
        level: 3,
        my: true,
        ticksToDowngrade: 20_000,
        progress: 0,
        progressTotal: 45_000,
      },
    };

    planTasks(board, here, 'ESTABLISHED', 1);
    planTasks(board, there, 'ESTABLISHED', 1);
    const both = boardSummary(board).total;

    // Now the neighbour has nothing worth doing.
    planTasks(board, { ...there, sources: [source('src2', 0)] }, 'ESTABLISHED', 2);

    const surviving = Object.values(board.tasks).filter((t) => t.room === 'W1N1');
    expect(surviving.length).toBeGreaterThan(0);
    expect(boardSummary(board).total).toBe(both - 1);
  });

  it('releases the lease when it prunes the holder\'s task', () => {
    // A creep whose work disappeared must not stay pinned to a task id that no
    // longer exists, or it can never be leased anything again.
    const board = emptyBoard();
    planTasks(board, room(), 'ESTABLISHED', 1);

    const leased = leaseTask(board, 'Bob', { roles: ['harvester'] }, 1);
    expect(leased?.kind).toBe('harvest');
    expect(boardSummary(board).leased).toBe(1);

    planTasks(board, room({ sources: [source('src1', 0)] }), 'ESTABLISHED', 2);

    expect(board.tasks[leased?.id ?? '']).toBeUndefined();
    expect(boardSummary(board).leased).toBe(0);
  });
});

describe('ownership', () => {
  it('plans nothing for a room whose controller is not ours', () => {
    const board = emptyBoard();
    const foreign = room({
      controller: {
        id: 'ctrl',
        x: 43,
        y: 17,
        level: 4,
        my: false,
        ticksToDowngrade: 20_000,
        progress: 0,
        progressTotal: 200,
      },
    });

    const result = planTasks(board, foreign, 'BOOTSTRAP', 1);

    expect(result).toEqual({ created: 0, pruned: 0 });
    expect(boardSummary(board).total).toBe(0);
  });
});

describe('tier-dependent planning', () => {
  it('plans no delivery work at BOOTSTRAP, where nothing buffers', () => {
    const board = emptyBoard();
    planTasks(board, room(), 'BOOTSTRAP', 1);
    expect(Object.values(board.tasks).some((t) => t.kind === 'deliver')).toBe(false);
  });

  it('plans delivery work once the colony buffers', () => {
    const board = emptyBoard();
    planTasks(board, room(), 'ESTABLISHED', 1);
    expect(Object.values(board.tasks).some((t) => t.kind === 'deliver')).toBe(true);
  });
});
