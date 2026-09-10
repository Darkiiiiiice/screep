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

/** True when a tile is walkable terrain with nothing on it. */
function isFree(room: Room, x: number, y: number): boolean {
  // The outermost ring is kept clear: a structure on the border can leave a
  // creep with no way round it.
  if (x < 1 || y < 1 || x > 48 || y > 48) return false;
  if (room.getTerrain().get(x, y) === TERRAIN_MASK_WALL) return false;
  if (room.lookForAt(LOOK_STRUCTURES, x, y).length > 0) return false;
  if (room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length > 0) return false;
  return true;
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
 * One pass of the ring search around the spawn.
 *
 * @param avoidWalls reject tiles touching a wall
 * @returns up to `count` free tiles, nearest first
 */
function search(
  room: Room,
  spawn: StructureSpawn,
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

        const x = spawn.pos.x + dx;
        const y = spawn.pos.y + dy;
        if (!isFree(room, x, y)) continue;
        if (avoidWalls && touchesWall(room, x, y)) continue;

        spots.push({ x, y });
      }
    }
  }

  return spots;
}

/**
 * Find tiles for a structure, nearest the spawn first.
 *
 * Two passes: clear of walls where possible, then anywhere free. The second pass
 * is what stops a room whose open ground is mostly walled edges from refusing to
 * build at all — an awkward placement beats no capacity.
 *
 * @returns the chosen tiles, possibly fewer than requested when the room is full
 */
export function findSpots(room: Room, spawn: StructureSpawn, count: number): { x: number; y: number }[] {
  const preferred = search(room, spawn, count, true);
  if (preferred.length >= count) return preferred;

  const anyFree = search(room, spawn, count, false);
  return anyFree.length > preferred.length ? anyFree : preferred;
}

/**
 * Place construction sites for the wanted structures.
 *
 * @returns how many sites were actually placed
 */
export function placeWanted(room: Room, wants: StructureWant[], roomViewForLog: RoomView): number {
  if (wants.length === 0) return 0;

  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return 0;

  let placed = 0;

  for (const want of wants) {
    const spots = findSpots(room, spawn, want.missing);

    if (spots.length === 0) {
      // Running out of room caps the economy, and the fix (clear something, or
      // expand) is a decision rather than a retry — so it is worth saying once.
      log(
        'warn',
        `build:${room.name}:${want.structureType}`,
        `${roomViewForLog.name} has no free tile for ${want.structureType} (ceiling ${String(want.ceiling)})`,
      );
      continue;
    }

    for (const spot of spots) {
      const code = room.createConstructionSite(
        spot.x,
        spot.y,
        want.structureType as BuildableStructureConstant,
      );
      if (code === OK) placed += 1;
    }
  }

  return placed;
}
