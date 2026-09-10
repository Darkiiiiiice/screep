/**
 * Verification track B: replay a recorded live room snapshot.
 *
 * What this buys that unit tests cannot: the domain is driven against the actual
 * geometry of a real room — real source positions, real spawn placement, real
 * terrain — so a planner that is correct in the abstract but wrong about this
 * room's layout fails here instead of on the live server, where finding out
 * costs a deploy from a 240/day budget.
 *
 * The snapshot in test/fixtures/rooms/ was recorded with `npm run snapshot` from
 * room W34S1 at the moment the account first had a spawn.
 *
 * What this does NOT cover: movement, damage, energy drain. A replay computes
 * intent, not physics — those only exist on the live server (see PLAN.md §4).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toRoomView, type RawSnapshot } from './from-snapshot';
import { deriveState } from '@/domain/state';
import { roleDemand, shortfall } from '@/domain/demand';
import { designForRole, bodyCost } from '@/domain/body';
import { planTasks } from '@/domain/plan';
import { emptyBoard, leaseTask, reapExpired } from '@/domain/tasks';
import { decide } from '@/domain/roles';
import type { Body, CreepView, Intent, Role } from '@/domain/types';

const FIXTURE_DIR = resolve(__dirname, '../fixtures/rooms');

function loadSnapshots(): RawSnapshot[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(FIXTURE_DIR, f), 'utf8')) as RawSnapshot);
}

/** A creep standing next to the spawn, as one just built would be. */
function creepAt(name: string, role: string, x: number, y: number, room: string): CreepView {
  return {
    name,
    role,
    x,
    y,
    room,
    energy: 0,
    carryCapacity: 50,
    parts: { work: 1, carry: 1, move: 1 },
    taskId: null,
  };
}

const snapshots = loadSnapshots();

describe('live snapshots', () => {
  it('has at least one recorded room to replay', () => {
    // Guards against the fixture directory being emptied, which would silently
    // make this whole file vacuous.
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it.each(snapshots.map((s) => [s.room, s] as const))(
    'reconstructs %s with the real structure it actually has',
    (_room, snapshot) => {
      const view = toRoomView(snapshot);

      expect(view.name).toBe(snapshot.room);
      expect(view.controller).not.toBeNull();
      expect(view.controller?.my).toBe(true);
      expect(view.spawns.length).toBeGreaterThan(0);
      expect(view.sources.length).toBeGreaterThan(0);
      // The spawn is the anchor of every early-game decision; without it the
      // colony cannot build anything and the snapshot is useless.
      expect(view.spawns[0]?.name).toBeTruthy();
    },
  );

  it.each(snapshots.map((s) => [s.room, s] as const))(
    'normalises %s controller downgrade to a relative count',
    (_room, snapshot) => {
      // The API gives an absolute `downgradeTime`; the domain needs the relative
      // count the in-game API exposes. A wrong conversion makes the
      // downgrade-urgency priority fire forever and starve every other task.
      const view = toRoomView(snapshot);
      const ticks = view.controller?.ticksToDowngrade ?? -1;

      expect(ticks).toBeGreaterThan(0);
      // RCL 1 downgrades over 20,000 ticks; the value must be in that ballpark
      // rather than an absolute timestamp.
      expect(ticks).toBeLessThanOrEqual(20_000);
    },
  );

  it.each(snapshots.map((s) => [s.room, s] as const))(
    'derives BOOTSTRAP for %s at its recorded level',
    (_room, snapshot) => {
      // The room was recorded with a fresh spawn, no extensions and no
      // container — the definition of BOOTSTRAP.
      const view = toRoomView(snapshot);
      const verdict = deriveState(view);

      expect(verdict.state).toBe('BOOTSTRAP');
      expect(verdict.reason).toMatch(/RCL 1/);
    },
  );
});

describe('demand against the real room', () => {
  const snapshot = snapshots[0] as RawSnapshot;

  it('wants a single self-hauling harvester at BOOTSTRAP', () => {
    // The room has two sources, but at BOOTSTRAP a 300-energy capacity supports
    // one creep that mines and hauls itself. Wanting one per source would make
    // the colony build a second harvester before it ever builds an upgrader —
    // and RCL 1 -> 2 costs only 200 energy for +250 capacity in extensions, so
    // that ordering is the expensive mistake to avoid.
    const view = toRoomView(snapshot);
    const demand = roleDemand(view, deriveState(view).state);
    const harvesters = demand.find((d) => d.role === 'harvester');

    expect(view.sources.length).toBeGreaterThan(1);
    expect(harvesters?.count).toBe(1);
    expect(harvesters?.reason).toMatch(/self-hauling/);
  });

  it('wants one harvester per source once containers exist', () => {
    // The scaling rule that makes sense at BOOTSTRAP is wrong later, and vice
    // versa: with a container buffering, a dedicated creep per source is what
    // raises income. Both branches are asserted so neither drifts silently.
    const base = toRoomView(snapshot);
    const established = {
      ...base,
      // A container is what promotes the state past BOOTSTRAP.
      stores: [
        ...base.stores,
        {
          id: 'cont1',
          type: 'container',
          x: 24,
          y: 6,
          room: base.name,
          energy: 0,
          energyCapacity: 2000,
        },
      ],
      controller: base.controller ? { ...base.controller, level: 3 } : null,
    };

    const state = deriveState(established).state;
    const demand = roleDemand(established, state);
    const harvesters = demand.find((d) => d.role === 'harvester');

    expect(state).toBe('ESTABLISHED');
    expect(harvesters?.count).toBe(established.sources.length);
  });

  it('wants a second upgrader once the room is energy-saturated', () => {
    // Measured live: the spawn pinned at 300/300 while controller progress sat
    // unchanged. At RCL 1 the controller is the only sink, so a full spawn is
    // dead capital — converting it into controller progress is the one thing
    // that unlocks everything else, and a second upgrader is nearly free when
    // the energy is already banked.
    const view = toRoomView(snapshot);
    const state = deriveState(view).state;
    const withSpawnAt = (energy: number) => ({
      ...view,
      spawns: view.spawns.map((s) => ({ ...s, energy })),
    });

    // Energy still scarce (the spawn has been drained by spawning): one upgrader.
    const scarce = roleDemand(withSpawnAt(0), state).find((d) => d.role === 'upgrader');
    expect(scarce?.count).toBe(1);
    expect(scarce?.reason).not.toMatch(/surplus/);

    // Spawn full: the surplus is now worth converting, so a second upgrader.
    const rich = roleDemand(withSpawnAt(view.spawns[0]?.energyCapacityAvailable ?? 300), state)
      .find((d) => d.role === 'upgrader');
    expect(rich?.count).toBe(2);
    expect(rich?.reason).toMatch(/surplus/);
  });

  it('does not add surplus upgraders past BOOTSTRAP, where extensions absorb it', () => {
    // Beyond BOOTSTRAP the extra energy has somewhere to go, so a second
    // upgrader is no longer free and the base quota applies.
    const view = toRoomView(snapshot);
    const established = {
      ...view,
      controller: view.controller ? { ...view.controller, level: 3 } : null,
      stores: [
        ...view.stores,
        {
          id: 'cont1',
          type: 'container' as const,
          x: 24,
          y: 6,
          room: view.name,
          energy: 0,
          energyCapacity: 2000,
        },
      ],
      spawns: view.spawns.map((s) => ({ ...s, energy: s.energyCapacityAvailable })),
    };

    const state = deriveState(established).state;
    expect(state).toBe('ESTABLISHED');
    expect(roleDemand(established, state).find((d) => d.role === 'upgrader')?.count).toBe(1);
  });

  it('wants no builders when the room has no construction sites', () => {
    // Spawning a builder against an empty site list is pure waste, and the real
    // room is a valid test of that because it genuinely has none.
    const view = toRoomView(snapshot);
    const demand = roleDemand(view, deriveState(view).state);

    expect(view.constructionSites).toHaveLength(0);
    expect(demand.find((d) => d.role === 'builder')?.count).toBe(0);
  });

  it('wants no haulers at BOOTSTRAP, where nothing buffers energy', () => {
    const view = toRoomView(snapshot);
    const demand = roleDemand(view, deriveState(view).state);
    expect(demand.find((d) => d.role === 'hauler')?.count ?? 0).toBe(0);
  });

  it('reports the full demand as missing against an empty population', () => {
    const view = toRoomView(snapshot);
    const state = deriveState(view).state;
    const gaps = shortfall(roleDemand(view, state), {});

    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0]?.role).toBe('harvester');
  });

  it('designs a harvester the real spawn can afford', () => {
    // The room's real energy capacity is the binding constraint: a body it
    // cannot pay for returns ERR_NOT_ENOUGH_ENERGY and the energy sits idle.
    const view = toRoomView(snapshot);
    const budget = view.spawns[0]?.energyCapacityAvailable ?? 0;
    const body = designForRole('harvester', budget);

    expect(budget).toBeGreaterThan(0);
    expect(body).not.toBeNull();
    expect(bodyCost(body as Body)).toBeLessThanOrEqual(budget);
  });
});

describe('intent sequence on the real room', () => {
  const snapshot = snapshots[0] as RawSnapshot;

  /** Run the plan/assign/decide pipeline once and collect the intents. */
  function replayOneTick(creeps: CreepView[]): Intent[] {
    const view = toRoomView(snapshot, { creeps });
    const state = deriveState(view).state;
    const board = emptyBoard();
    const now = snapshot.gameTime;

    reapExpired(board, now, {});
    planTasks(board, view, state, now);

    const intents: Intent[] = [];
    for (const creep of view.creeps) {
      const task = leaseTask(board, creep.name, { roles: [creep.role as Role] }, now);
      const intent = decide(creep, task, view);
      if (intent) intents.push(intent);
    }
    return intents;
  }

  it('sends an empty harvester toward a real source', () => {
    const spawn = toRoomView(snapshot).spawns[0];
    const creeps = [creepAt('h1', 'harvester', spawn?.x ?? 25, spawn?.y ?? 25, snapshot.room)];

    const intents = replayOneTick(creeps);
    const target = intents[0];

    expect(target).toBeDefined();
    // Either harvesting an adjacent source, or approaching one — both are
    // correct depending on the real distance.
    expect(['harvest', 'approach']).toContain(target?.kind);

    const view = toRoomView(snapshot);
    if (target?.kind === 'approach') {
      // The approach names a real source and the range the action needs, which
      // is what lets the engine path to a reachable tile beside it.
      expect(view.sources.some((s) => s.id === target.targetId)).toBe(true);
      expect(target.range).toBe(1);
    }
  });

  it('sends a loaded harvester to the spawn to deliver', () => {
    // At BOOTSTRAP the spawn is the only sink, so this is the delivery half of
    // the only economic loop the room can run.
    const spawn = toRoomView(snapshot).spawns[0];
    const loaded = { ...creepAt('h1', 'harvester', spawn?.x ?? 25, spawn?.y ?? 25, snapshot.room), energy: 50 };

    const intents = replayOneTick([loaded]);
    const kinds = intents.map((i) => i.kind);

    expect(kinds.some((k) => k === 'transfer' || k === 'approach')).toBe(true);
  });

  it('produces the same intent sequence on a repeated replay', () => {
    // Determinism is what makes this harness meaningful: replaying the same
    // snapshot must always agree, or a diff between runs means nothing.
    const spawn = toRoomView(snapshot).spawns[0];
    const creeps = [creepAt('h1', 'harvester', spawn?.x ?? 25, spawn?.y ?? 25, snapshot.room)];

    expect(replayOneTick(creeps)).toEqual(replayOneTick(creeps));
  });

  it('refuses to act on a room it does not own', () => {
    // Safety property: no intent may be produced that spends another player's
    // resources or moves into their room.
    const view = toRoomView(snapshot);
    const disowned = { ...view, controller: view.controller ? { ...view.controller, my: false } : null };

    expect(deriveState(disowned).state).toBe('BOOTSTRAP');
    const state = deriveState(disowned).state;
    const board = emptyBoard();
    planTasks(board, disowned, state, snapshot.gameTime);

    // With no owned controller there is nothing worth planning against.
    expect(Object.keys(board.tasks)).toHaveLength(0);
  });
});
