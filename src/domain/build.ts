/**
 * What the colony wants built.
 *
 * This answers "how many of which structure", never "where". Placement needs
 * terrain, occupancy and traffic knowledge, which lives in the engine — so the
 * spatial half belongs in `src/game/build.ts` while this stays pure.
 *
 * Counts come from the official structure table (docs/control.html). Building up
 * to the ceiling takes priority over upgrading, because capacity compounds:
 * measured at RCL 1, the spawn sat full at 300/300 with nowhere for spare energy
 * to go; RCL 2's five extensions raise the ceiling to 550, which is 83% more
 * energy the room can hold and therefore convert.
 */
import type { RoomView } from './types';

/**
 * Structure ceiling by controller level.
 *
 * The official table is cumulative (RCL 4 permits 20 extensions, not 20 more),
 * so this is a total, not an increment. Only types the colony currently builds
 * appear: towers and storage arrive at RCL 3 and 4, while combat and links are
 * M4/M5 concerns.
 */
const STRUCTURE_CEILING: Record<number, Record<string, number>> = {
  2: { extension: 5, container: 2 },
  3: { extension: 10, container: 5, tower: 1 },
  4: { extension: 20, container: 5, tower: 1, storage: 1 },
  5: { extension: 30, container: 5, tower: 2, storage: 1 },
  6: { extension: 40, container: 5, tower: 2, storage: 1, terminal: 1 },
  7: { extension: 50, container: 5, tower: 3, storage: 1, terminal: 1 },
  8: { extension: 60, container: 5, tower: 6, storage: 1, terminal: 1 },
};

/** RCL 8 is the top of the table, so that is as far as "build up to" goes. */
const MAX_LEVEL = 8;

/**
 * Note on containers: the official table permits five of them from RCL 0, but
 * they are deferred to RCL 2 here. At RCL 1 a container's 250 energy competes
 * with the 200 that unlocks the first extensions, and the extensions come first.
 * From RCL 2 the container is the single best purchase available: it sits beside
 * a source so the harvester's round trip shrinks from a walk across the room to
 * a step, which is what the ESTABLISHED economy is built on.
 */

/**
 * New sites allowed per tick.
 *
 * Two, so one spawn's worth of energy is not committed to construction at once
 * and the colony keeps filling the extensions it already has. A builder finishes
 * one site at a time anyway; a long queue only ties energy up in half-built
 * structures.
 */
const MAX_SITES_PER_TICK = 2;

export interface StructureWant {
  structureType: string;
  /** How many more sites to place. */
  missing: number;
  /** Ceiling this was derived from, for the console line. */
  ceiling: number;
}

/**
 * Structures the colony should start building right now.
 *
 * Existing structures AND sites under construction both count toward the
 * ceiling. Counting only finished structures would queue a duplicate site for
 * everything already being built, and waste the builders on redundant work.
 *
 * @returns one entry per structure type below its ceiling, empty below RCL 2
 */
export function structureWants(room: RoomView): StructureWant[] {
  const level = room.controller?.level ?? 0;
  const ceiling = STRUCTURE_CEILING[Math.min(level, MAX_LEVEL)];
  if (!ceiling) return [];

  const existing: Record<string, number> = {};
  for (const store of room.stores) {
    existing[store.type] = (existing[store.type] ?? 0) + 1;
  }
  for (const site of room.constructionSites) {
    existing[site.structureType] = (existing[site.structureType] ?? 0) + 1;
  }

  const wants: StructureWant[] = [];

  for (const [structureType, allowed] of Object.entries(ceiling)) {
    const have = existing[structureType] ?? 0;
    if (have >= allowed) continue;

    wants.push({
      structureType,
      missing: Math.min(allowed - have, MAX_SITES_PER_TICK),
      ceiling: allowed,
    });
  }

  return wants;
}
