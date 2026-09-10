/**
 * Spawn manager: decides what to build and asks a spawn to do it.
 *
 * `domain/demand` answers "how many of each role do we want". This file answers
 * "given that, what do we queue right now", which depends on facts only the
 * engine has — and each of them is a way to get this wrong:
 *
 *   - A spawn runs one creep at a time. Asking a busy spawn returns ERR_BUSY,
 *     and the request is simply lost, so an idle check comes first.
 *   - A creep being built does NOT appear in `Game.creeps` yet. If it is not
 *     counted against demand, the manager re-queues the same role every tick
 *     until the first one hatches. The engine already knows what is being built
 *     (`spawn.spawning`), so that — not a counter we maintain — is the source
 *     of truth.
 *   - The body must fit `room.energyCapacityAvailable`, which counts only BUILT
 *     extensions. Overshooting returns ERR_NOT_ENOUGH_ENERGY and the energy sits
 *     idle.
 */
import { bodyCost, designForRole } from '../domain/body';
import { roleDemand, shortfall } from '../domain/demand';
import type { Body, ColonyState, Intent, Role, RoomView } from '../domain/types';
import { guard } from '../kernel/errors';

export interface SpawnDecision {
  role: Role;
  body: Body;
  name: string;
  /** Energy the body costs; the spawn must have at least this much. */
  cost: number;
}

/**
 * Choose a name for a creep.
 *
 * Must be unique among living creeps. `Game.time` is unique per tick and a
 * spawn completes at most one creep per tick, so time plus role plus room is
 * collision-free without maintaining a counter.
 */
function creepName(role: Role, room: string): string {
  return `${role}-${room}-${String(Game.time)}`;
}

/**
 * What to spawn next, or null when nothing should be queued.
 *
 * `shortfalls` is ordered most-urgent-first by the domain, and only the head is
 * acted on: queuing several bodies at once would consume the spawn for
 * hundreds of ticks and make the colony unable to react to a death.
 */
export function nextSpawn(
  shortfalls: { role: Role }[],
  budget: number,
  room: string,
): SpawnDecision | null {
  const first = shortfalls[0];
  if (!first) return null;

  const body = designForRole(first.role, budget);
  // Null means even a minimal body is unaffordable. Waiting for energy is
  // correct: a crippled creep is worse than a delayed one.
  if (!body) return null;

  return {
    role: first.role,
    body,
    name: creepName(first.role, room),
    cost: bodyCost(body),
  };
}

/** Population by role, including creeps still being built. */
export function populationByRole(view: RoomView): Partial<Record<string, number>> {
  const counts: Partial<Record<string, number>> = {};

  for (const creep of view.creeps) {
    counts[creep.role] = (counts[creep.role] ?? 0) + 1;
  }

  for (const spawn of view.spawns) {
    const role = spawn.spawningRole;
    if (role) counts[role] = (counts[role] ?? 0) + 1;
  }

  return counts;
}

/**
 * Run the spawn phase for a room.
 *
 * @returns the spawn intents to execute, and a reason when there are none —
 *   the reason is surfaced in the stats segment, because "why is nothing
 *   spawning" is the first question when an economy stalls.
 */
export function planSpawns(view: RoomView, state: ColonyState): { intents: Intent[]; reason: string } {
  const idle = view.spawns.filter((s) => !s.spawning);
  if (idle.length === 0) {
    return {
      intents: [],
      reason: view.spawns.length === 0 ? 'no spawn in room' : 'all spawns busy',
    };
  }

  const spawn = idle[0];
  if (!spawn) return { intents: [], reason: 'no idle spawn' };

  const gaps = shortfall(roleDemand(view, state), populationByRole(view));
  if (gaps.length === 0) return { intents: [], reason: 'demand met' };

  // Sized against what the room can spend RIGHT NOW, not what it can hold.
  // `spawnCreep` draws on current energy, so a body sized against capacity while
  // the spawn is empty fails with ERR_NOT_ENOUGH_ENERGY — the colony would ask
  // for the same body every tick and get nothing. Using current energy also
  // makes the body grow on its own as extensions fill up.
  const budget = Math.min(spawn.energyAvailable, spawn.energyCapacityAvailable);
  if (budget <= 0) return { intents: [], reason: 'no energy banked' };

  const decision = guard(() => nextSpawn(gaps, budget, view.name), 'spawn decision');
  if (!decision) {
    const wanted = gaps[0]?.role ?? 'unknown';
    return {
      intents: [],
      reason: `cannot afford ${wanted} (budget ${String(budget)}, capacity ${String(spawn.energyCapacityAvailable)})`,
    };
  }

  return {
    intents: [
      {
        kind: 'spawn',
        room: view.name,
        spawn: spawn.name,
        body: decision.body,
        name: decision.name,
        role: decision.role,
      },
    ],
    reason: `queue ${decision.role} (${String(decision.cost)}e)`,
  };
}
