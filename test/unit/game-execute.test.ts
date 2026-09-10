import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { execute } from '@/game/execute';

let engine: FakeEngine | undefined;

/** Recorded arguments from each `moveTo` call, in order. */
let moves: { x: number; y: number; reusePath: number | undefined }[];

interface FakeCreep {
  name: string;
  pos: { x: number; y: number };
  moveTo: (target: unknown, opts?: { range?: number; reusePath?: number }) => number;
}

function moveCreepTo(creep: FakeCreep, x: number, y: number): void {
  creep.pos.x = x;
  creep.pos.y = y;
}

beforeEach(() => {
  engine = installFakeEngine();
  moves = [];
});

afterEach(() => {
  engine?.restore();
  engine = undefined;
});

/** Install a creep plus a static target for it to approach. */
function setup(creepAt: { x: number; y: number }): FakeCreep {
  const creep: FakeCreep = {
    name: 'c1',
    pos: { ...creepAt },
    moveTo: (_target, opts) => {
      moves.push({ x: creep.pos.x, y: creep.pos.y, reusePath: opts?.reusePath });
      // Deliberately does NOT move the creep: this models a blocked step, which
      // is the situation the reusePath reset exists for.
      return 0;
    },
  };

  const target = { id: 't1', pos: { x: 24, y: 10 } };

  engine?.addObject('t1', target);
  if (engine) engine.game.creeps[creep.name] = creep;
  return creep;
}

describe('approach', () => {
  it('passes the requested range so the engine can pick a reachable tile', () => {
    // Sources, spawns and controllers occupy solid tiles, so a creep sent to
    // their exact coordinates gets ERR_NO_PATH.
    const creep = setup({ x: 30, y: 30 });
    execute({ kind: 'approach', creep: creep.name, targetId: 't1', range: 1 });

    expect(moves).toHaveLength(1);
  });

  it('uses the cached path on the first attempt', () => {
    const creep = setup({ x: 30, y: 30 });
    execute({ kind: 'approach', creep: creep.name, targetId: 't1', range: 1 });

    expect(moves[0]?.reusePath).toBe(15);
  });

  it('keeps caching while the creep is making progress', () => {
    const creep = setup({ x: 30, y: 30 });

    // Walking normally: a new tile each tick, so the cache stays valid.
    for (let i = 0; i < 5; i += 1) {
      moveCreepTo(creep, 30 - i, 30);
      execute({ kind: 'approach', creep: creep.name, targetId: 't1', range: 1 });
      if (engine) engine.advanceTick();
    }

    expect(moves.map((m) => m.reusePath)).toEqual([15, 15, 15, 15, 15]);
  });

  it('recomputes once the creep has gone nowhere for several ticks', () => {
    // Measured live: a creep sat on one tile for 12 ticks because its cached path
    // ran through a tile that had since been occupied, and it kept retrying the
    // blocked step.
    const creep = setup({ x: 30, y: 30 });

    for (let i = 0; i < 5; i += 1) {
      execute({ kind: 'approach', creep: creep.name, targetId: 't1', range: 1 });
      if (engine) engine.advanceTick();
    }

    expect(moves.slice(0, 4).map((m) => m.reusePath)).toEqual([15, 15, 15, 15]);
    expect(moves[4]?.reusePath).toBe(0);
  });

  it('also catches an oscillating creep, which never repeats a tile', () => {
    // The second measured failure mode, and the reason progress is measured over
    // a neighbourhood: a creep bounced between two adjacent tiles for 40+ ticks,
    // which a "same tile as last tick" test never sees.
    const creep = setup({ x: 30, y: 30 });

    for (let i = 0; i < 5; i += 1) {
      moveCreepTo(creep, i % 2 === 0 ? 30 : 31, 30);
      execute({ kind: 'approach', creep: creep.name, targetId: 't1', range: 1 });
      if (engine) engine.advanceTick();
    }

    expect(moves[4]?.reusePath).toBe(0);
  });

  it('starts a fresh progress window after a recompute', () => {
    const creep = setup({ x: 30, y: 30 });

    for (let i = 0; i < 5; i += 1) {
      execute({ kind: 'approach', creep: creep.name, targetId: 't1', range: 1 });
      if (engine) engine.advanceTick();
    }
    expect(moves[4]?.reusePath).toBe(0);

    execute({ kind: 'approach', creep: creep.name, targetId: 't1', range: 1 });
    expect(moves[5]?.reusePath).toBe(15);
  });

  it('does not carry a stale mark across a different creep', () => {
    // Marks are keyed by name; a second creep must not inherit the first's state.
    const first = setup({ x: 30, y: 30 });
    for (let i = 0; i < 5; i += 1) {
      execute({ kind: 'approach', creep: first.name, targetId: 't1', range: 1 });
      if (engine) engine.advanceTick();
    }

    const second: FakeCreep = {
      name: 'c2',
      pos: { x: 30, y: 30 },
      moveTo: (_t, opts) => {
        moves.push({ x: 30, y: 30, reusePath: opts?.reusePath });
        return 0;
      },
    };
    if (engine) engine.game.creeps[second.name] = second;

    execute({ kind: 'approach', creep: second.name, targetId: 't1', range: 1 });

    expect(moves.at(-1)?.reusePath).toBe(15);
  });
});
