/**
 * Colony lifecycle state.
 *
 * The state is a PURE derivation from the controller level plus the structures
 * actually standing. Nothing is stored in Memory: the same input always yields
 * the same state, so a runtime restart, a lost heap, or a replayed snapshot all
 * agree. (Storing it would also create the failure mode where Memory says
 * ESTABLISHED while the room has been stripped.)
 *
 * The state matters because roles are not a fixed list — the same role does
 * different work at RCL 1 and RCL 6. A harvester at RCL 1 walks between source
 * and spawn; at RCL 4 a container does the buffering and a hauler does the
 * walking. Encoding the level in one place keeps that from scattering into
 * per-role `if (rcl > n)` checks.
 *
 * Thresholds come from the official structure table (docs/control.html); the
 * structural prerequisites are checked as well as the level, because a room can
 * hold a level while missing the structure that makes the next strategy sane.
 */
import type { ColonyState, RoomView } from './types';

/** Minimum controller level for each state. */
const MIN_LEVEL: Record<ColonyState, number> = {
  BOOTSTRAP: 0,
  // 2, not 3: the container is what defines this state, and a container can be
  // placed from RCL 2 (see domain/build.ts). An earlier value of 3 read the
  // level off the extension table rather than off the structure that actually
  // changes the economy, and it delayed the hauler-based model by a full level.
  ESTABLISHED: 2,
  MATURE: 6,
  EXPANSION: 8,
};

export interface StateVerdict {
  state: ColonyState;
  /** Why this state, for the console and the stats segment. */
  reason: string;
}

/**
 * Derive the colony state for a room.
 *
 * Ordered from the top down: the highest state whose level threshold AND
 * structural prerequisites are both satisfied wins.
 */
export function deriveState(room: RoomView): StateVerdict {
  const controller = room.controller;

  if (!controller || !controller.my) {
    return { state: 'BOOTSTRAP', reason: 'no owned controller' };
  }

  const level = controller.level;
  const types = new Set(room.stores.map((s) => s.type));

  if (level >= MIN_LEVEL.EXPANSION) {
    return { state: 'EXPANSION', reason: `RCL ${String(level)}` };
  }

  // MATURE turns on the level-6 economy: a terminal for trade/energy routing and
  // links for short-range transfer. Without them the level alone does not make
  // the link-and-storage strategy usable.
  if (level >= MIN_LEVEL.MATURE) {
    if (types.has('terminal')) {
      return { state: 'MATURE', reason: `RCL ${String(level)} with terminal` };
    }
    return {
      state: 'ESTABLISHED',
      reason: `RCL ${String(level)} but no terminal yet`,
    };
  }

  // ESTABLISHED is where containers make hauling worthwhile. Below RCL 3 there
  // are no extensions to fill, so harvesters deliver straight to the spawn.
  if (level >= MIN_LEVEL.ESTABLISHED) {
    if (types.has('container') || types.has('storage')) {
      return { state: 'ESTABLISHED', reason: `RCL ${String(level)} with container` };
    }
    return {
      state: 'BOOTSTRAP',
      reason: `RCL ${String(level)} but no container to buffer into`,
    };
  }

  return { state: 'BOOTSTRAP', reason: `RCL ${String(level)}` };
}

/**
 * The next controller level's energy cost, per the official table.
 *
 * Used to reason about pacing: RCL 1→2 costs 200, but 2→3 costs 45,000 — a 225x
 * cliff that dominates the early game and is why BOOTSTRAP→ESTABLISHED is gated
 * on sustained energy throughput rather than on the level number alone.
 */
export const UPGRADE_COST: Record<number, number> = {
  1: 200,
  2: 45_000,
  3: 135_000,
  4: 405_000,
  5: 1_215_000,
  6: 3_645_000,
  7: 10_935_000,
};

/**
 * Total energy needed to reach `target` from RCL 1.
 *
 * Exposed so the M3 acceptance criterion ("RCL 1→5 = 585,200 energy") is
 * computed rather than transcribed.
 */
export function energyToReach(target: number): number {
  let total = 0;
  for (let level = 1; level < target; level += 1) {
    total += UPGRADE_COST[level] ?? 0;
  }
  return total;
}
