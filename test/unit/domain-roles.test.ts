import { describe, expect, it } from 'vitest';
import { decide, rangeBetween } from '@/domain/roles';
import type { CreepView, RoomView, SourceView, SpawnView, StoreView } from '@/domain/types';

function creep(overrides: Partial<CreepView> = {}): CreepView {
  return {
    name: 'c1',
    role: 'harvester',
    x: 10,
    y: 10,
    room: 'W1N1',
    energy: 0,
    carryCapacity: 50,
    ticksToLive: null,
    parts: { work: 2, carry: 1, move: 1 },
    taskId: null,
    ...overrides,
  };
}

function source(id: string, x: number, y: number, energy = 3000): SourceView {
  return { id, x, y, room: 'W1N1', energy, ticksToRegeneration: 0 };
}

function store(id: string, type: string, x: number, y: number, energy: number, cap?: number): StoreView {
  return { id, type, x, y, room: 'W1N1', energy, energyCapacity: cap };
}

function room(overrides: Partial<RoomView> = {}): RoomView {
  return {
    name: 'W1N1',
    controller: {
      id: 'ctrl',
      x: 43,
      y: 17,
      level: 1,
      my: true,
      ticksToDowngrade: 20_000,
      progress: 0,
      progressTotal: 200,
    },
    spawns: [],
    sources: [source('src1', 24, 5)],
    stores: [store('spawn1', 'spawn', 24, 10, 0, 300)],
    constructionSites: [],
    creeps: [],
    hostiles: [],
    ...overrides,
  };
}

/**
 * The spawn appears in BOTH views: `stores` for deposits, `spawns` for the
 * banking check. Setting only one is a trap that has now caught a test twice —
 * `room.spawns[0]` is then undefined and every banking path returns null.
 */
const spawnAt = (energy: number, capacity = 300): SpawnView => ({
  id: 'spawn1',
  name: 'Spawn1',
  x: 24,
  y: 10,
  room: 'W1N1',
  energy,
  energyAvailable: energy,
  energyCapacityAvailable: capacity,
  spawning: false,
  spawningName: null,
  spawningRole: null,
  spawnTicksRemaining: 0,
});

describe('rangeBetween', () => {
  it('is Chebyshev distance, matching 8-directional movement', () => {
    // Movement is 8-directional, so a diagonal step covers both axes at once.
    // Using Manhattan here would make the bot move when it could already act.
    expect(rangeBetween({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(3);
    expect(rangeBetween({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(3);
    expect(rangeBetween({ x: 0, y: 0 }, { x: 1, y: 5 })).toBe(5);
    expect(rangeBetween({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
  });
});

/**
 * A room with a living harvester, i.e. one whose spawn may be drained.
 *
 * The distinction matters: without a harvester the spawn is reserved so it can
 * accumulate a replacement (see `hasIncome`).
 */
function roomWithIncome(overrides: Partial<RoomView> = {}): RoomView {
  const base = room(overrides);
  return {
    ...base,
    creeps: [
      ...base.creeps,
      {
        name: 'miner',
        role: 'harvester',
        ticksToLive: null,
        x: 24,
        y: 6,
        room: base.name,
        energy: 0,
        carryCapacity: 50,
        parts: { work: 1, carry: 1, move: 2 },
        taskId: null,
      },
    ],
  };
}

describe('fill before travel', () => {
  it('keeps a partially loaded harvester on the source instead of delivering', () => {
    // Measured live failure: delivering on `energy > 0` meant one tick of
    // harvesting (4 energy) followed by five tiles of walking, so the room sat
    // at zero controller progress. Capacity is 50, so filling first multiplies
    // throughput for the same walking.
    const view = room();
    // Adjacent to the source, so the only question is whether it mines more or
    // leaves to deliver.
    const intent = decide(creep({ energy: 4, x: 24, y: 6 }), null, view);

    expect(intent?.kind).toBe('harvest');
  });

  it('delivers once the harvester is full', () => {
    const view = room();
    const intent = decide(creep({ energy: 50, x: 24, y: 11 }), null, view);

    expect(intent?.kind).toBe('transfer');
  });

  it('delivers a partial load when the source has nothing left', () => {
    // Standing still until the source regrows is worse than delivering now.
    const view = room({ sources: [source('src1', 24, 5, 0)] });
    const intent = decide(creep({ energy: 20, x: 24, y: 11 }), null, view);

    expect(intent?.kind).toBe('transfer');
  });

  it('does nothing with no energy and no source to mine', () => {
    const view = room({ sources: [] });
    expect(decide(creep({ energy: 0 }), null, view)).toBeNull();
  });

  it('approaches a source it is not adjacent to', () => {
    // `approach` names the source rather than a destination tile: a source is
    // solid, so a creep sent to its exact coordinates gets ERR_NO_PATH.
    const view = room();
    const intent = decide(creep({ x: 30, y: 30 }), null, view);

    expect(intent?.kind).toBe('approach');
    expect((intent as { targetId: string }).targetId).toBe('src1');
    expect((intent as { range: number }).range).toBe(1);
  });

  it('harvests in place when adjacent to the source', () => {
    const view = room();
    const intent = decide(creep({ x: 24, y: 6 }), null, view);

    expect(intent?.kind).toBe('harvest');
  });

  it('applies the same rule to the upgrader', () => {
    // Worse for the upgrader than the harvester: the controller is far from the
    // sources, so upgrading 2 energy per round trip is almost all walking.
    const view = room({ stores: [store('spawn1', 'spawn', 24, 10, 0, 300)] });
    const hoarding = decide(creep({ role: 'upgrader', energy: 3, x: 24, y: 6 }), null, view);
    const full = decide(creep({ role: 'upgrader', energy: 50, x: 43, y: 18 }), null, view);

    expect(hoarding?.kind).toBe('harvest');
    expect(full?.kind).toBe('upgrade');
  });

  it('applies the same rule to the builder', () => {
    const view = room({
      sources: [source('src1', 24, 5)],
      constructionSites: [
        {
          id: 'site1',
          x: 30,
          y: 30,
          room: 'W1N1',
          structureType: 'road',
          progress: 0,
          progressTotal: 100,
        },
      ],
    });

    expect(decide(creep({ role: 'builder', energy: 4, x: 24, y: 6 }), null, view)?.kind).toBe(
      'harvest',
    );
    expect(
      decide(creep({ role: 'builder', energy: 50, x: 30, y: 29 }), null, view)?.kind,
    ).toBe('build');
  });
});

describe('act locally, travel only when necessary', () => {
  // The measured bug: an upgrader reached the controller, spent 2 of its 50
  // energy, decided it was "not full", and walked 19 tiles back to a source to
  // top up. Controller progress sat still while three creeps commuted.
  it('keeps upgrading while carrying energy, instead of topping up', () => {
    const view = room();
    // Standing on the controller with most of a load left.
    const intent = decide(creep({ role: 'upgrader', energy: 48, x: 43, y: 16 }), null, view);

    expect(intent?.kind).toBe('upgrade');
    expect((intent as { targetId: string }).targetId).toBe('ctrl');
  });

  it('keeps upgrading even with a single energy left', () => {
    // Spending the last unit is free — the creep must travel to refill either
    // way, so interrupting to top up first only loses the unit.
    const view = room();
    const intent = decide(creep({ role: 'upgrader', energy: 1, x: 43, y: 16 }), null, view);

    expect(intent?.kind).toBe('upgrade');
  });

  it('heads for the controller rather than topping up when the source is further away', () => {
    // The distance comparison is what replaces a magic "full enough" threshold:
    // a creep in the middle of the room must not walk past its destination.
    const view = room({
      sources: [source('src1', 24, 5)],
      controller: {
        id: 'ctrl',
        x: 30,
        y: 12,
        level: 1,
        my: true,
        ticksToDowngrade: 20_000,
        progress: 0,
        progressTotal: 200,
      },
    });

    // At (29,13): controller is 1 tile away, source is 9 away.
    const intent = decide(creep({ role: 'upgrader', energy: 40, x: 29, y: 13 }), null, view);

    expect(intent?.kind).toBe('upgrade');
  });

  it('does top up when the supply is the nearer of the two', () => {
    const view = room({
      controller: {
        id: 'ctrl',
        x: 43,
        y: 17,
        level: 1,
        my: true,
        ticksToDowngrade: 20_000,
        progress: 0,
        progressTotal: 200,
      },
    });

    // At (24,6): adjacent to the source, 19 tiles from the controller.
    const intent = decide(creep({ role: 'upgrader', energy: 1, x: 24, y: 6 }), null, view);

    expect(intent?.kind).toBe('harvest');
  });

  it('delivers locally rather than carrying energy past a sink', () => {
    const view = room();
    // Adjacent to the spawn, carrying a partial load. Walking away to mine first
    // would mean hauling it back later.
    const intent = decide(creep({ energy: 12, x: 24, y: 11 }), null, view);

    expect(intent?.kind).toBe('transfer');
    expect((intent as { targetId: string }).targetId).toBe('spawn1');
  });

  it('still fills up before a long trip when it is at the source', () => {
    // The complement of act-locally: away from any sink, mining more beats
    // hauling a nearly empty carry across the room.
    const view = room();
    const intent = decide(creep({ energy: 4, x: 24, y: 6 }), null, view);

    expect(intent?.kind).toBe('harvest');
  });
});

describe('income recovery', () => {
  // The hole this closes was real, not theoretical. Measured: the sole harvester
  // reached the end of its 1500-tick life and the surviving consumers mined as
  // intended — but an upgrader spends what it mines on the controller and a
  // builder spends it on a site. Neither deposits, so nothing could accumulate
  // the ~250 a replacement harvester costs. The colony recovered only because a
  // dropped pile happened to decay into the spawn, one unit per tick.
  const noIncome = (overrides: Partial<RoomView> = {}): RoomView =>
    room({
      stores: [store('spawn1', 'spawn', 24, 10, 100, 300)],
      spawns: [spawnAt(100)],
      sources: [source('src1', 24, 5)],
      ...overrides,
    });

  it('banks energy into the spawn when no harvester exists', () => {
    // Carrying energy and standing next to the spawn: banking is the only action
    // that can restore income.
    const intent = decide(creep({ role: 'upgrader', energy: 40, x: 24, y: 11 }), null, noIncome());

    expect(intent?.kind).toBe('transfer');
    expect((intent as { targetId: string }).targetId).toBe('spawn1');
  });

  it('does the same for a builder, instead of spending on a site', () => {
    // The builder is the role most tempted to spend: it always has a site. With
    // no income, a half-built extension is worth less than a working harvester.
    const view = noIncome({
      constructionSites: [
        {
          id: 'site1',
          x: 30,
          y: 30,
          room: 'W1N1',
          structureType: 'extension',
          progress: 0,
          progressTotal: 3000,
        },
      ],
    });

    const intent = decide(creep({ role: 'builder', energy: 40, x: 24, y: 11 }), null, view);
    expect(intent?.kind).toBe('transfer');
  });

  it('stops spending on the controller while the colony cannot buy a harvester', () => {
    const view = noIncome();
    // Adjacent to the controller, which would normally mean "upgrade".
    const intent = decide(
      creep({ role: 'upgrader', energy: 40, x: 24, y: 11 }),
      null,
      { ...view, controller: view.controller ? { ...view.controller, x: 24, y: 12 } : null },
    );

    expect(intent?.kind).toBe('transfer');
  });

  it('still mines when empty and there is no income', () => {
    // Recovery requires a source of energy; banking only matters once something
    // has been mined.
    const intent = decide(creep({ role: 'upgrader', energy: 0, x: 24, y: 6 }), null, noIncome());
    expect(intent?.kind).toBe('harvest');
  });

  it('leaves normal behaviour alone while a harvester is alive', () => {
    // The rule is a rescue, not the default: with income the colony keeps
    // upgrading and building rather than hoarding.
    const view = roomWithIncome({
      stores: [store('spawn1', 'spawn', 24, 10, 100, 300)],
    });
    const intent = decide(creep({ role: 'upgrader', energy: 40, x: 24, y: 11 }), null, view);

    expect(intent?.kind).not.toBe('transfer');
  });

  it('counts a harvester still being built as income', () => {
    // A replacement already committed to means recovery is under way, so the
    // colony can go back to spending.
    const view = noIncome({
      spawns: [
        {
          ...spawnAt(100),
          spawning: true,
          spawningName: 'harvester-W1N1-1',
          spawningRole: 'harvester',
          spawnTicksRemaining: 10,
        },
      ],
    });

    const intent = decide(creep({ role: 'upgrader', energy: 40, x: 24, y: 11 }), null, view);
    expect(intent?.kind).not.toBe('transfer');
  });

  it('gives up on banking when the room is already full', () => {
    // Nothing to gain: `spawnCreep` draws on a full pool, and if it cannot afford
    // a harvester while full then the problem is not energy.
    const view = noIncome({
      stores: [store('spawn1', 'spawn', 24, 10, 300, 300)],
      spawns: [spawnAt(300)],
    });
    const intent = decide(creep({ role: 'upgrader', energy: 40, x: 24, y: 11 }), null, view);

    expect(intent?.kind).not.toBe('transfer');
  });
});

describe('energy source preference', () => {
  it('prefers a buffer over the spawn, whose stock is reserved for spawning', () => {
    // Draining the spawn trades long-term survival for short-term progress: the
    // spawn's energy is what replaces a dead creep.
    const view = room({
      stores: [
        store('spawn1', 'spawn', 24, 10, 300, 300),
        store('cont1', 'container', 30, 30, 500, 2000),
      ],
    });
    const intent = decide(creep({ role: 'upgrader', x: 30, y: 31 }), null, view);

    expect(intent?.kind).toBe('withdraw');
    expect((intent as { targetId: string }).targetId).toBe('cont1');
  });

  it('draws from the spawn when a harvester is keeping it full', () => {
    // Measured failure this pins: with the spawn full at 300/300, a builder and
    // an upgrader sat at zero energy within sight of it, both stuck walking to a
    // distant source. At RCL 1-2 the spawn is the room's only energy store, and
    // a store that cannot be drained is not a buffer.
    const view = roomWithIncome({ stores: [store('spawn1', 'spawn', 24, 10, 300, 300)] });
    const intent = decide(creep({ role: 'upgrader', energy: 0, x: 24, y: 11 }), null, view);

    expect(intent?.kind).toBe('withdraw');
    expect((intent as { targetId: string }).targetId).toBe('spawn1');
  });

  it('holds back enough of the spawn to buy a replacement harvester', () => {
    // The death spiral this prevents, observed live: one harvester, four
    // consumers, spawn pinned low. When the harvester reached the end of its
    // 1500-tick life there was nothing banked to replace it, and the remaining
    // creeps took every arriving unit — so the spawn could never accumulate the
    // ~250 a harvester body costs, and nothing but a harvester refills it.
    //
    // Below the reserve, consumers mine for themselves instead.
    const view = room({
      sources: [source('src1', 24, 5)],
      stores: [store('spawn1', 'spawn', 24, 10, 249, 300)],
    });

    const intent = decide(creep({ role: 'upgrader', energy: 0, x: 24, y: 11 }), null, view);

    expect(intent?.kind).not.toBe('withdraw');
    if (intent?.kind === 'approach') {
      expect((intent as { targetId: string }).targetId).toBe('src1');
    } else {
      expect(intent?.kind).toBe('harvest');
    }
  });

  it('lets consumers draw the surplus above the reserve', () => {
    // The floor is not a lock. Measured earlier: excluding the spawn outright
    // starved a builder and an upgrader at zero energy beside a spawn holding
    // 300. A spawn at full capacity holds nothing back that a replacement needs.
    const view = room({
      stores: [store('spawn1', 'spawn', 24, 10, 300, 300)],
    });

    const intent = decide(creep({ role: 'upgrader', energy: 0, x: 24, y: 11 }), null, view);
    expect(intent?.kind).toBe('withdraw');
    expect((intent as { targetId: string }).targetId).toBe('spawn1');
  });

  it('allows a withdrawal that crosses the reserve, draining down to it', () => {
    // Withdrawals are not clamped to the remainder: the check bounds what the
    // spawn is OFFERED at, so the level settles just below the reserve rather
    // than hovering above it.
    const view = room({
      stores: [store('spawn1', 'spawn', 24, 10, 251, 300)],
    });

    const intent = decide(creep({ role: 'upgrader', energy: 0, x: 24, y: 11 }), null, view);
    expect(intent?.kind).toBe('withdraw');
  });

  it('falls back to mining only when every store is empty', () => {
    const view = room({ stores: [store('spawn1', 'spawn', 24, 10, 0, 300)] });
    const intent = decide(creep({ role: 'upgrader', energy: 0, x: 24, y: 6 }), null, view);

    expect(intent?.kind).toBe('harvest');
  });

  it('sends a builder to the spawn rather than the source when the spawn holds energy', () => {
    const view = roomWithIncome({
      sources: [source('src1', 24, 5)],
      stores: [store('spawn1', 'spawn', 24, 10, 300, 300)],
      constructionSites: [
        {
          id: 'site1',
          x: 30,
          y: 30,
          room: 'W1N1',
          structureType: 'extension',
          progress: 0,
          progressTotal: 3000,
        },
      ],
    });

    // Adjacent to the spawn; the source is 5 tiles away.
    const intent = decide(creep({ role: 'builder', energy: 0, x: 24, y: 11 }), null, view);

    expect(intent?.kind).toBe('withdraw');
    expect((intent as { targetId: string }).targetId).toBe('spawn1');
  });

  it('keeps the harvester mining rather than queueing at the spawn', () => {
    // A miner mines. Sending it to withdraw what it could dig up itself would
    // also add contention at the spawn with the consumers that need it.
    const view = roomWithIncome({ stores: [store('spawn1', 'spawn', 24, 10, 300, 300)] });
    const intent = decide(creep({ energy: 0, x: 24, y: 11 }), null, view);

    expect(intent?.kind).not.toBe('withdraw');
  });
});

describe('ownership safety', () => {
  it('does nothing in a room whose controller is not ours', () => {
    // Safety property: no intent may spend another player's resources.
    const view = room({
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

    expect(decide(creep({ role: 'upgrader', energy: 50 }), null, view)).toBeNull();
  });
});


describe('threat withdrawal', () => {
  /**
   * The policy this covers used to be inert. It lived in `planTasks` as "do not
   * create the upgrade task while hostiles are present" — but `decideUpgrader`
   * never reads its task, so the controller kept advancing with a hostile in the
   * room. Measured against the real engine: the upgrade task was pruned every
   * tick and progress was unaffected.
   *
   * These assert the intent a consumer observes, not the task board.
   */
  const upgrader = (overrides: Partial<CreepView> = {}) =>
    creep({ role: 'upgrader', x: 43, y: 16, energy: 50, ...overrides });

  it('upgrades normally when the room is clear', () => {
    // The contrast case: without this, the threat tests below could pass because
    // the upgrader never upgrades at all.
    const intent = decide(upgrader(), null, room());
    expect(intent?.kind).toBe('upgrade');
  });

  it('stops upgrading when a hostile is present', () => {
    const withHostile = room({ hostiles: [{ id: 'h1', x: 10, y: 10 }] });
    const intent = decide(upgrader(), null, withHostile);
    expect(intent?.kind).not.toBe('upgrade');
  });

  it('banks the energy it carries instead, so replacements stay affordable', () => {
    // Banking is the whole point of withdrawing: the controller can be let down
    // and recovered, but a colony that cannot buy creeps cannot recover.
    const withHostile = room({
      hostiles: [{ id: 'h1', x: 10, y: 10 }],
      stores: [store('spawn1', 'spawn', 24, 10, 0, 300)],
      spawns: [spawnAt(0)],
    });
    const intent = decide(upgrader({ x: 24, y: 11 }), null, withHostile);
    expect(intent).toMatchObject({ kind: 'transfer', targetId: 'spawn1' });
  });

  it('idles rather than upgrading when it carries nothing to bank', () => {
    // Nothing to bank and no fighting to do. Idling is the honest response; what
    // it must NOT do is spend the withdrawal on the controller anyway.
    const withHostile = room({ hostiles: [{ id: 'h1', x: 10, y: 10 }] });
    expect(decide(upgrader({ energy: 0 }), null, withHostile)).toBeNull();
  });

  it('leaves the other roles alone while a hostile is present', () => {
    // The withdrawal is scoped to the upgrader. Harvesting must continue: income
    // is what pays for the creeps that will eventually replace the losses, and
    // the threat may well outlast the run.
    const withHostile = room({ hostiles: [{ id: 'h1', x: 10, y: 10 }] });
    const intent = decide(creep({ role: 'harvester', x: 24, y: 5, energy: 0 }), null, withHostile);
    expect(intent?.kind).toBe('harvest');
  });
});
