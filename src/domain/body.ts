import type { Body, BodyPart } from './types';

/**
 * Creep body design.
 *
 * Pure: takes an energy budget, returns a list of body parts. This is the one
 * place where the colony decides what it can afford, and it is easy to get
 * wrong in ways that only show up live — an unaffordable body makes
 * `spawnCreep` fail silently with ERR_NOT_ENOUGH_ENERGY, and an immobile body
 * (no MOVE) strands a creep that still occupies spawn capacity.
 *
 * So the rules are explicit and tested:
 *   - Never exceed the budget.
 *   - Never exceed 50 parts (engine cap).
 *   - Always include MOVE. A body without MOVE is a stuck creep.
 *   - Return null rather than a degenerate body when the budget cannot buy a
 *     usable block — the caller waits for energy instead of spawning a cripple.
 */

/** Energy cost per body part, per the engine's constants. */
const PART_COST: Record<BodyPart, number> = {
  tough: 10,
  move: 50,
  carry: 50,
  work: 100,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
};

/** Engine cap on parts per creep. */
const MAX_PARTS = 50;

/** A body's part counts, e.g. `{ work: 2, carry: 1, move: 1 }`. */
export type BodyRatio = Partial<Record<BodyPart, number>>;

export type { Body };

/** Energy cost of a part list. */
export function bodyCost(body: Body): number {
  let total = 0;
  for (const part of body) total += PART_COST[part] ?? Infinity;
  return total;
}

/** Expand a ratio into a flat part list. */
function expand(ratio: BodyRatio, blocks: number, extra: BodyRatio = {}): Body {
  const body: Body = [];
  for (const part of Object.keys(ratio) as BodyPart[]) {
    const n = (ratio[part] ?? 0) * blocks + (extra[part] ?? 0);
    for (let i = 0; i < n; i += 1) body.push(part);
  }
  return body;
}

/**
 * Shrink a ratio toward one of each part.
 *
 * Used when the full block is unaffordable: rather than wait for energy, the
 * colony should build the best creep the budget actually supports. A 200-energy
 * harvester mines more slowly than a 300-energy one, but it mines; an unspent
 * spawn produces nothing at all.
 *
 * Dividing every count by `divisor` (never below 1) preserves the shape while
 * reducing cost, and keeps MOVE present at every step.
 */
function shrink(ratio: BodyRatio, divisor: number): BodyRatio {
  const out: BodyRatio = {};
  for (const part of Object.keys(ratio) as BodyPart[]) {
    out[part] = Math.max(1, Math.floor((ratio[part] ?? 0) / divisor));
  }
  return out;
}

/**
 * Find the largest body shape that fits, starting from the requested ratio and
 * shrinking it only as far as necessary.
 *
 * @returns the effective ratio and how many copies of it fit, or null when even
 *   the minimal shape is unaffordable.
 */
function fitRatio(budget: number, ratio: BodyRatio): { ratio: BodyRatio; blocks: number } | null {
  const maxDivisor = Math.max(...Object.values(ratio).map((n) => n ?? 0));

  for (let divisor = 1; divisor <= maxDivisor; divisor += 1) {
    const candidate = shrink(ratio, divisor);
    const cost = bodyCost(expand(candidate, 1));
    if (cost > budget) continue;

    const parts = Object.values(candidate).reduce<number>((a, b) => a + (b ?? 0), 0);
    const maxBlocks = Math.floor(MAX_PARTS / parts);
    return { ratio: candidate, blocks: Math.min(Math.floor(budget / cost), maxBlocks) };
  }

  return null;
}

/**
 * Design the largest body of the given shape that fits the budget.
 *
 * @param budget energy available for this creep
 * @param ratio  the desired shape, e.g. `{ work: 2, carry: 1, move: 1 }`
 * @returns the body, or null when even a minimal usable body is unaffordable
 */
export function designBody(budget: number, ratio: BodyRatio): Body | null {
  // A body without MOVE cannot move; refuse to design one at all rather than
  // let a caller forget the constraint.
  if (!ratio.move || ratio.move < 1) {
    throw new Error('body ratio must include at least one MOVE part');
  }
  if (bodyCost(expand(ratio, 1)) === Infinity) {
    throw new Error(`body ratio has unknown parts: ${JSON.stringify(ratio)}`);
  }

  const fitted = fitRatio(budget, ratio);
  if (!fitted || fitted.blocks < 1) return null;

  const { ratio: effective, blocks } = fitted;
  const blockCost = bodyCost(expand(effective, 1));
  const blockParts = Object.values(effective).reduce<number>((a, b) => a + (b ?? 0), 0);

  // Spend the remainder on single parts, in descending ratio order so the
  // result stays closest to the requested shape.
  const priority = (Object.keys(effective) as BodyPart[]).sort(
    (a, b) => (effective[b] ?? 0) - (effective[a] ?? 0),
  );

  let remaining = budget - blocks * blockCost;
  let partsUsed = blocks * blockParts;
  const extra: BodyRatio = {};

  // Loop because a cheap ratio under a large budget leaves more than one block's
  // worth of change.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const part of priority) {
      const cost = PART_COST[part] ?? Infinity;
      if (partsUsed + 1 > MAX_PARTS) break;
      if (cost > remaining) continue;
      extra[part] = (extra[part] ?? 0) + 1;
      remaining -= cost;
      partsUsed += 1;
      progressed = true;
    }
  }

  return expand(effective, blocks, extra);
}

/** Count how many of a part a body contains. */
export function countPart(body: Body, part: BodyPart): number {
  let n = 0;
  for (const p of body) if (p === part) n += 1;
  return n;
}

/**
 * The canonical body shapes per role.
 *
 * Chosen against the two constraints that actually bite early:
 *   - HARVEST rate is 2 energy/tick per WORK part, so WORK is what shortens the
 *     time to fill CARRY; a 1:1 WORK:CARRY ratio means 25 ticks to fill.
 *   - MOVE must keep pace with CARRY or the creep crawls; one MOVE per CARRY
 *     part is the cheap safe ratio on plain terrain.
 *
 * `upgrader` and `builder` are pure energy consumers, so they carry more than
 * they harvest and skip WORK entirely — they deliver what a harvester fills.
 */
export const ROLE_RATIO: Record<string, BodyRatio> = {
  // Self-harvests and delivers: needs WORK to mine, CARRY to hold, MOVE to travel.
  harvester: { work: 2, carry: 1, move: 1 },
  // Carries from container to consumer; no WORK at all.
  hauler: { carry: 2, move: 1 },
  // Spends energy on the controller; no WORK, no harvesting.
  upgrader: { work: 1, carry: 1, move: 1 },
  builder: { work: 1, carry: 1, move: 1 },
  // Combat parts are expensive; keep the first responder small and fast.
  defender: { attack: 1, move: 1 },
};

/** Design the body for a role against a budget. */
export function designForRole(role: string, budget: number): Body | null {
  const ratio = ROLE_RATIO[role];
  if (!ratio) return null;
  return designBody(budget, ratio);
}
