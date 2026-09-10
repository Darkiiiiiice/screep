/**
 * Role demand: how many creeps of each role the colony wants right now.
 *
 * This returns TARGET counts, not deltas. The spawn manager diffs them against
 * the living population — keeping the "what do we want" question separate from
 * "what do we do about it" is what makes the target testable on its own.
 *
 * The numbers are driven by what actually binds early: energy throughput and
 * spawn capacity. Note that creeps have no energy upkeep in this game, so the
 * real cost of an excess creep is spawn time plus the CPU of running it every
 * tick — and CPU is the scarce resource at a 20 ms budget. Over-recruiting is
 * therefore not free even when energy looks plentiful.
 */
import type { ColonyState, Role, RoomView } from './types';

export interface RoleDemand {
  role: Role;
  /** Desired total population for this role. */
  count: number;
  /** Why this number, for the console and tests. */
  reason: string;
}

/**
 * Baseline quota per state, before scaling by the room's sources and sites.
 *
 * BOOTSTRAP has no containers, so harvesters must both mine and walk the energy
 * to the spawn — the least efficient configuration, and the one where an extra
 * creep is most likely to starve. One upgrader is kept regardless because the
 * controller downgrade timer at RCL 1 is 20,000 ticks and level 2 unlocks the
 * 45,000-energy climb.
 */
const BASE_QUOTA: Record<ColonyState, Partial<Record<Role, number>>> = {
  BOOTSTRAP: { harvester: 1, upgrader: 1 },
  // Containers now buffer, so a hauler becomes worth its own spawn cost and the
  // harvesters stop walking.
  ESTABLISHED: { harvester: 1, hauler: 1, upgrader: 1 },
  MATURE: { harvester: 1, hauler: 1, upgrader: 2 },
  EXPANSION: { harvester: 1, hauler: 2, upgrader: 2 },
};

/**
 * How many upgraders the room should have.
 *
 * At BOOTSTRAP the controller is the ONLY sink: RCL 1 has no extensions and the
 * spawn caps at 300, so once the spawn is full every further unit of energy has
 * nowhere to go. Measured live: spawn pinned at 300/300 while controller progress
 * sat unchanged — the colony was energy-rich and upgrade-poor, with a full spawn
 * acting as dead capital.
 *
 * A second upgrader is nearly free in that state (the energy is already banked)
 * and roughly doubles the rate at which it is converted into the one thing that
 * unlocks everything else. So the count follows energy abundance: one upgrader
 * while energy is scarce, two once the stores are full.
 *
 * Beyond BOOTSTRAP, extensions and (later) storage absorb the surplus, and the
 * extra upgrader is no longer free — so the base quota applies.
 */
function upgraderCount(state: ColonyState, room: RoomView, base: number): number {
  if (state !== 'BOOTSTRAP') return base;

  const spawn = room.spawns[0];
  if (!spawn) return base;

  // Compare the ROOM's stored energy against the ROOM's capacity. An earlier
  // version compared the spawn's own store against the room capacity, which
  // works at RCL 1 only because both happen to be 300 — once five extensions
  // exist the spawn can never hold 550, so saturation was never detected and
  // the second upgrader was never requested.
  const saturated = spawn.energyAvailable >= spawn.energyCapacityAvailable;
  return saturated ? Math.max(base, 2) : base;
}

/**
 * Compute role demand for a room.
 *
 * @param room  the room's snapshot
 * @param state the derived colony state (see state.ts)
 */
export function roleDemand(room: RoomView, state: ColonyState): RoleDemand[] {
  const base = BASE_QUOTA[state];
  const sourceCount = Math.max(1, room.sources.length);
  const siteCount = room.constructionSites.length;

  const demands: RoleDemand[] = [];

  // One harvester per source at ESTABLISHED and above: there, containers buffer
  // and a dedicated creep can sit on a source, so saturating each source is
  // what raises income.
  //
  // At BOOTSTRAP that rule actively hurts, because it makes the colony build a
  // second harvester before it ever builds an upgrader. A 300-capacity room
  // supports one self-hauling creep, and RCL 1 -> 2 costs only 200 energy while
  // unlocking 5 extensions (+250 capacity) — the best return available anywhere
  // in the early game. Delaying it to double the harvester count is a bad trade.
  const harvesters = state === 'BOOTSTRAP' ? 1 : Math.max(base.harvester ?? 1, sourceCount);
  demands.push({
    role: 'harvester',
    count: harvesters,
    reason: state === 'BOOTSTRAP' ? 'single self-hauling creep' : `${String(sourceCount)} source(s)`,
  });

  if (base.hauler) {
    // A hauler carries 100 per two CARRY parts and never mines; it replaces the
    // walking half of several harvesters, so it scales sub-linearly with sources.
    const haulers = Math.max(base.hauler, Math.ceil(sourceCount / 2));
    demands.push({ role: 'hauler', count: haulers, reason: `sources/2 = ${String(haulers)}` });
  }

  if (base.upgrader) {
    const count = upgraderCount(state, room, base.upgrader);
    demands.push({
      role: 'upgrader',
      count,
      reason:
        count > base.upgrader
          ? `controller progress + downgrade timer (surplus energy: ${String(count)})`
          : 'controller progress + downgrade timer',
    });
  }

  // Builders exist only when there is something to build. Spawning one against
  // an empty site list is pure waste.
  demands.push({
    role: 'builder',
    count: siteCount > 0 ? 1 : 0,
    reason: siteCount > 0 ? `${String(siteCount)} site(s)` : 'no sites',
  });

  // No defender is requested. Observed live: a transient hostile caused one to
  // be spawned, and it then stood idle forever — `decide()` has no defender
  // behaviour, so the role had no way to act. Spending 300 energy and a spawn
  // slot on a creep that cannot do anything is worse than not spawning it, so
  // the demand stays at zero until combat is designed (M5).
  //
  // Note the standing risk this leaves: were a hostile to arrive now, nothing
  // in the colony reacts to it. At RCL 1 that is unavoidable — there are no
  // towers and a 2-ATTACK creep cannot kill an invader — so the honest position
  // is that early-game defence is "none", not "a defender that idles".

  return demands;
}

/**
 * Roles whose current population is below demand, most urgent first.
 *
 * Ordering is the spawn priority: replacing a harvester matters more than
 * adding an upgrader, because without income nothing else progresses.
 */
const SPAWN_PRIORITY: Role[] = ['harvester', 'hauler', 'upgrader', 'builder'];

export interface RoleShortfall {
  role: Role;
  /** How many more are wanted. */
  missing: number;
  reason: string;
}

/**
 * Compute the shortfall between demand and the living population.
 *
 * Creeps already being spawned are counted by the caller (it can see the spawn
 * queue); this function only compares numbers, so it stays pure.
 */
export function shortfall(
  demand: RoleDemand[],
  living: Partial<Record<string, number>>,
): RoleShortfall[] {
  const gaps: RoleShortfall[] = [];

  for (const { role, count, reason } of demand) {
    const have = living[role] ?? 0;
    if (have < count) gaps.push({ role, missing: count - have, reason });
  }

  return gaps.sort(
    (a, b) => SPAWN_PRIORITY.indexOf(a.role) - SPAWN_PRIORITY.indexOf(b.role),
  );
}
