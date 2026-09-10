/**
 * Site placement: choose where a wanted structure goes, and place it.
 *
 * This is the spatial half of building, and it is deliberately NOT in the
 * domain: choosing a tile needs terrain, occupancy and traffic knowledge, all of
 * which only the engine has. The domain says "five extensions"; this decides
 * which five tiles.
 *
 * Placement rule: as close to the spawn as possible, without taking a tile a
 * creep needs to walk through. Extensions are where haulers deliver, so distance
 * to the spawn is distance per delivery, repeated for the life of the room — the
 * cheapest available win is putting them adjacent.
 *
 * Construction is placed by the player (`room.createConstructionSite`), not by a
 * creep, so this runs directly from the tick rather than through an intent.
 */
import type { RoomView } from '../domain/types';
import type { StructureWant } from '../domain/build';
import { log } from '../kernel/log';

/**
 * True when a tile is walkable terrain with nothing on it.
 *
 * The outermost ring is kept clear, since a structure on the border can leave a
 * creep no way round it.
 */
function isFree(room: Room, x: number, y: number): boolean {
  if (x < 1 || y < 1 || x > 48 || y > 48) return false;
  if (room.getTerrain().get(x, y) === TERRAIN_MASK_WALL) return false;
  if (room.lookForAt(LOOK_STRUCTURES, x, y).length > 0) return false;
  if (room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length > 0) return false;
  return true;
}

/**
 * A tile a creep can stand on, ignoring creep positions.
 *
 * Creeps move, so they are not treated as obstacles in these reachability
 * checks — the question is whether the ROOM's layout permits a route.
 */
function isWalkable(room: Room, x: number, y: number, extraBlocked: string[]): boolean {
  if (x < 1 || y < 1 || x > 48 || y > 48) return false;
  const key = `${String(x)},${String(y)}`;
  if (extraBlocked.includes(key)) return false;
  if (room.getTerrain().get(x, y) === TERRAIN_MASK_WALL) return false;
  if (room.lookForAt(LOOK_STRUCTURES, x, y).length > 0) return false;
  if (room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length > 0) return false;
  return true;
}

/** Any walkable tile orthogonally or diagonally adjacent to `target`. */
function approaches(room: Room, target: { x: number; y: number }): string[] {
  const out: string[] = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const x = target.x + dx;
      const y = target.y + dy;
      if (isWalkable(room, x, y, [])) out.push(`${String(x)},${String(y)}`);
    }
  }
  return out;
}

/**
 * Could a creep get from the spawn to a source, given extra blocked tiles?
 *
 * This is the invariant that matters, checked directly rather than approximated
 * by a geometric rule. An earlier version reserved only the spawn's eight
 * neighbours, which is not sufficient: movement is 8-directional, so blocking
 * specific tiles at radius 2 can still seal a corridor while the ring stays
 * clear. Measured live, the spawn became unreachable and a loaded harvester
 * bounced between two tiles for 40+ ticks without ever delivering.
 *
 * A test of the actual property also cannot be outgrown. Any rule about which
 * tiles to avoid is a guess about which arrangements are dangerous; a
 * breadth-first search over the room answers the question.
 */
export function spawnReachesSource(room: Room, spawn: StructureSpawn, extraBlocked: string[]): boolean {
  const sources = room.find(FIND_SOURCES);
  if (sources.length === 0) return true;

  const targets: Record<string, true> = {};
  for (const source of sources) {
    for (const tile of approaches(room, source.pos)) targets[tile] = true;
  }

  // Start from the spawn's own walkable neighbours: a creep cannot stand on it.
  const start = approaches(room, spawn.pos);
  const seen: Record<string, true> = {};
  const queue = start.slice();

  for (const tile of start) seen[tile] = true;
  if (targets[start[0] ?? ''] === true) return true;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (targets[current] === true) return true;

    const [cx, cy] = current.split(',').map(Number) as [number, number];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        const key = `${String(nx)},${String(ny)}`;
        if (seen[key] === true) continue;
        if (!isWalkable(room, nx, ny, extraBlocked)) continue;

        seen[key] = true;
        queue.push(key);
      }
    }
  }

  return false;
}

/**
 * True when a tile touches a wall.
 *
 * A structure beside a wall can pinch a corridor: creeps move 8-directionally,
 * so a wall and a structure diagonally offset each other still leave a diagonal
 * gap that pathfinders treat very differently from an open tile. Measured
 * earlier in this room, creeps in a tight corridor blocked each other into
 * ERR_NO_PATH, so tiles next to walls are avoided while better ones exist.
 */
function touchesWall(room: Room, x: number, y: number): boolean {
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      if (room.getTerrain().get(x + dx, y + dy) === TERRAIN_MASK_WALL) return true;
    }
  }
  return false;
}

/**
 * One pass of the ring search around an anchor tile.
 *
 * @param avoidWalls reject tiles touching a wall
 * @returns up to `count` free tiles, nearest first
 */
function search(
  room: Room,
  anchor: { x: number; y: number },
  count: number,
  avoidWalls: boolean,
): { x: number; y: number }[] {
  const spots: { x: number; y: number }[] = [];

  // Rings outward, so the first tile found is the closest one.
  for (let radius = 1; radius <= 10 && spots.length < count; radius += 1) {
    for (let dx = -radius; dx <= radius && spots.length < count; dx += 1) {
      for (let dy = -radius; dy <= radius && spots.length < count; dy += 1) {
        // Ring only: the interior was covered at a smaller radius.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;

        const x = anchor.x + dx;
        const y = anchor.y + dy;
        if (!isFree(room, x, y)) continue;
        if (avoidWalls && touchesWall(room, x, y)) continue;

        spots.push({ x, y });
      }
    }
  }

  return spots;
}

/**
 * Find tiles for a structure, nearest the anchor first.
 *
 * Two passes: clear of walls where possible, then anywhere free. The second pass
 * is what stops a room whose open ground is mostly walled edges from refusing to
 * build at all — an awkward placement beats no capacity.
 *
 * @returns the chosen tiles, possibly fewer than requested when the room is full
 */
export function findSpots(
  room: Room,
  anchor: { x: number; y: number },
  count: number,
): { x: number; y: number }[] {
  const preferred = search(room, anchor, count, true);
  if (preferred.length >= count) return preferred;

  const anyFree = search(room, anchor, count, false);
  return anyFree.length > preferred.length ? anyFree : preferred;
}

/**
 * Where a structure type should be anchored.
 *
 * The anchor is not a detail — it decides whether the structure does its job at
 * all. Measured: containers were placed beside the spawn by a spawn-anchored
 * search, four and six tiles from the nearest source. A container exists to
 * buffer energy AT the mining site, so a container away from the source leaves
 * the harvester walking the full round trip and buys nothing; the throughput
 * estimate that justified building it (2.08 -> 2.8 energy/tick) assumed the
 * container was adjacent to the source.
 *
 * Extensions and towers are the opposite: they are delivery targets, so distance
 * to the spawn is distance per delivery, repeated for the life of the room.
 */
function anchorsFor(room: Room, kind: string, spawn: StructureSpawn): { x: number; y: number }[] {
  if (kind === 'container') {
    // One container per source. A source with a container beside it is what turns
    // a cross-room walk into a step.
    return room.find(FIND_SOURCES).map((s) => ({ x: s.pos.x, y: s.pos.y }));
  }
  return [{ x: spawn.pos.x, y: spawn.pos.y }];
}

/**
 * How close a container must be to a source to be worth building.
 *
 * The same figure the placement search uses: a container buffers energy at the
 * mining site, so one further away than a step leaves the harvester walking.
 */
const CONTAINER_ADJACENCY = 2;

/**
 * Remove container sites that are nowhere near a source.
 *
 * This is a MIGRATION, not a routine step, and it exists because the ceiling rule
 * makes a misplaced site self-perpetuating: `structureWants` counts sites under
 * construction toward the ceiling, so two wrong containers at RCL 2 fill the
 * quota of two and the correct pair can never be placed. Measured on the live
 * room — two container sites sat 4 and 6 tiles from the nearest source, and
 * without this they would have been built, delivering none of the throughput the
 * containers were paid for, with the fix only taking effect at RCL 3 when the
 * ceiling rises to 5.
 *
 * Only SITES are reclaimed. A built container cannot be moved without destroying
 * it, so a wrong one is left alone; this is about not spending energy on a
 * mistake that has not been paid for yet.
 *
 * @returns how many sites were removed
 */
export function reclaimMisplacedContainers(room: Room, sources: Source[]): number {
  if (sources.length === 0) return 0;

  let removed = 0;
  for (const site of room.find(FIND_MY_CONSTRUCTION_SITES)) {
    if (site.structureType !== STRUCTURE_CONTAINER) continue;

    const nearest = Math.min(
      ...sources.map((s) => Math.max(Math.abs(site.pos.x - s.pos.x), Math.abs(site.pos.y - s.pos.y))),
    );
    if (nearest <= CONTAINER_ADJACENCY) continue;

    if (site.remove() === OK) removed += 1;
  }

  return removed;
}

/**
 * Remove sites that sit on the spawn's approach ring.
 *
 * Repairs rooms built before the ring was reserved. The sites are discarded
 * rather than relocated in place; the next `placeWanted` puts them somewhere
 * legal, and a site holds no energy that clearing it would waste.
 *
 * @returns how many sites were removed
 */
export function clearBlockingSites(room: Room): number {
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return 0;

  const existing = room.find(FIND_MY_CONSTRUCTION_SITES);
  if (spawnReachesSource(room, spawn, [])) return 0;

  // The room is already walled. Remove sites until a route exists again,
  // closest to the spawn first: those are the ones most likely to be the seal,
  // and the ones whose removal reopens the most space.
  const candidates = existing
    .slice()
    .sort(
      (a, b) =>
        Math.max(Math.abs(a.pos.x - spawn.pos.x), Math.abs(a.pos.y - spawn.pos.y)) -
        Math.max(Math.abs(b.pos.x - spawn.pos.x), Math.abs(b.pos.y - spawn.pos.y)),
    );

  let removed = 0;
  const blocked: string[] = [];
  for (const site of candidates) {
    blocked.push(`${String(site.pos.x)},${String(site.pos.y)}`);
    // `remove()` takes effect next tick, so test against the simulated set.
    const stillSealed = !spawnReachesSource(room, spawn, blocked.map((k) => k));
    if (stillSealed) continue;
    if (site.remove() === OK) removed += 1;
  }

  return removed;
}

/**
 * Place construction sites for the wanted structures.
 *
 * @returns how many sites were actually placed
 */
export function placeWanted(room: Room, wants: StructureWant[], roomViewForLog: RoomView): number {
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return 0;

  // Repair BEFORE the "nothing wanted" early return. A room whose spawn is
  // already walled in has its structure ceiling met, so `wants` is empty — and
  // returning early here meant the repair never ran at all, leaving the spawn
  // sealed and the colony permanently stalled.
  const cleared = clearBlockingSites(room);
  if (cleared > 0) {
    log(
      'warn',
      `build:${roomViewForLog.name}:clear`,
      `${roomViewForLog.name} cleared ${String(cleared)} site(s) blocking the spawn approach`,
    );
  }

  // Migration, and it must run before the want list is consulted: a misplaced
  // container occupies a slot in the ceiling, so reclaiming it is what frees the
  // slot for a correct one in the SAME tick.
  const reclaimed = reclaimMisplacedContainers(room, room.find(FIND_SOURCES));
  if (reclaimed > 0) {
    log(
      'warn',
      `build:${roomViewForLog.name}:reclaim`,
      `${roomViewForLog.name} reclaimed ${String(reclaimed)} misplaced container site(s)`,
    );
  }

  if (wants.length === 0) return 0;

  let placed = 0;

  for (const want of wants) {
    const anchors = anchorsFor(room, want.structureType, spawn);
    let remaining = want.missing;

    for (const anchor of anchors) {
      if (remaining <= 0) break;

      // One spot per anchor for containers, so two sources get one each rather
      // than both containers landing beside the same source.
      const perAnchor = want.structureType === 'container' ? 1 : remaining;
      const spots = findSpots(room, anchor, perAnchor);

      for (const spot of spots) {
        if (remaining <= 0) break;

        // Verify the placement keeps the spawn connected to a source. A site that
        // seals the room is worse than no site at all — it costs the whole
        // economy, not just the structure.
        const tentatively = [`${String(spot.x)},${String(spot.y)}`];
        if (!spawnReachesSource(room, spawn, tentatively)) {
          log(
            'warn',
            `build:${roomViewForLog.name}:connectivity`,
            `${roomViewForLog.name} skipped ${want.structureType} at (${String(spot.x)},${String(spot.y)}): would block the spawn`,
          );
          continue;
        }

        const code = room.createConstructionSite(
          spot.x,
          spot.y,
          want.structureType as BuildableStructureConstant,
        );
        if (code === OK) {
          placed += 1;
          remaining -= 1;
        }
      }
    }

    if (remaining === want.missing) {
      // Running out of room caps the economy, and the fix (clear something, or
      // expand) is a decision rather than a retry — so it is worth saying once.
      log(
        'warn',
        `build:${room.name}:${want.structureType}`,
        `${roomViewForLog.name} found no legal tile for ${want.structureType} (ceiling ${String(want.ceiling)})`,
      );
    }
  }

  return placed;
}
