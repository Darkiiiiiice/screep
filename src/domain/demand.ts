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
    demands.push({
      role: 'upgrader',
      count: base.upgrader,
      reason: 'controller progress + downgrade timer',
    });
  }

  // Builders exist only when there is something to build. Spawning one against
  // an empty site list is pure waste.
  demands.push({
    role: 'builder',
    count: siteCount > 0 ? 1 : 0,
    reason: siteCount > 0 ? `${String(siteCount)} site(s)` : 'no sites',
  });

  // A defender appears only in response to an actual hostile.
  demands.push({
    role: 'defender',
    count: room.hostiles.length > 0 ? 1 : 0,
    reason: room.hostiles.length > 0 ? `${String(room.hostiles.length)} hostile(s)` : 'no hostiles',
  });

  return demands;
}

/**
 * Roles whose current population is below demand, most urgent first.
 *
 * Ordering is the spawn priority: replacing a harvester matters more than
 * adding an upgrader, because without income nothing else progresses.
 */
const SPAWN_PRIORITY: Role[] = ['harvester', 'defender', 'hauler', 'upgrader', 'builder'];

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
