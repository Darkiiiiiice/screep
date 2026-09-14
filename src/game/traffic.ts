import { arbitrateMoves, observeTraffic } from '../domain/traffic';

interface Intent { creep: Creep; next: RoomPosition; priority: number }
const intents = new Map<string, Intent>();
let tick = -1;
const key = (pos: RoomPosition) => `${pos.roomName}:${pos.x}:${pos.y}`;
const STEPS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const OBSTACLE_STRUCTURES: ReadonlySet<string> = new Set([
  'spawn', 'extension', 'link', 'storage', 'tower', 'observer', 'powerSpawn', 'powerBank',
  'lab', 'terminal', 'nuker', 'factory', 'invaderCore', 'constructedWall', 'controller',
]);

function prepare(): void {
  if (tick !== Game.time) {
    intents.clear(); tick = Game.time;
  }
}

function passable(room: Room, x: number, y: number): boolean {
  for (const result of room.lookAt(x, y)) {
    if (result.type === 'terrain') { if (result.terrain === 'wall') return false; continue; }
    if (result.type === 'structure' && result.structure && OBSTACLE_STRUCTURES.has(result.structure.structureType)) return false;
    if (result.type === 'source' || result.type === 'mineral' || result.type === 'deposit') return false;
  }
  return true;
}

/**
 * The pathfinder found no creep-free route that reaches the target: a stationary
 * occupant holds the only approach or the target is sealed off. Step only when it
 * strictly shortens the remaining distance - into a free cell, or into a
 * creep-occupied cell so the arbitration can rotate a ring. Sealed-off pockets offer
 * no improving step: hold position and let the backoff cycle engage.
 */
function approach(creep: Creep, target: RoomPosition): RoomPosition | undefined {
  const here = Math.abs(creep.pos.x - target.x) + Math.abs(creep.pos.y - target.y);
  const candidates = STEPS
    .map(([dx, dy]) => [creep.pos.x + dx, creep.pos.y + dy] as const)
    .filter(([x, y]) => x >= 0 && x < 50 && y >= 0 && y < 50 && passable(creep.room, x, y))
    .map(([x, y]) => ({
      pos: new RoomPosition(x, y, creep.room.name),
      dist: Math.abs(x - target.x) + Math.abs(y - target.y),
      occupied: creep.room.lookAt(x, y).some(result => result.type === 'creep' && !!result.creep && result.creep.id !== creep.id),
    }))
    .filter(cell => cell.dist < here)
    .sort((a, b) => a.dist - b.dist || Number(a.occupied) - Number(b.occupied));
  return candidates[0]?.pos;
}

export function requestMove(creep: Creep, target: RoomPosition, range: number): void {
  prepare();
  if ((creep.memory.traffic?.retryAt ?? 0) > Game.time) return;
  const state = observeTraffic(creep.memory.traffic, creep.pos.x, creep.pos.y, Game.time, `${key(target)}:${range}`, creep.fatigue > 0);
  creep.memory.traffic = state;
  if (state.retryAt) { delete creep.memory.shipment; return; }
  if (creep.fatigue || creep.pos.inRangeTo(target, range)) return;
  const steps = creep.pos.findPathTo(target, { range, ignoreCreeps: state.stuck < 3, maxRooms: 1 });
  let step: RoomPosition | undefined;
  if (steps.length) {
    let endX = creep.pos.x, endY = creep.pos.y;
    for (const s of steps) { endX += s.dx; endY += s.dy; }
    if (Math.max(Math.abs(endX - target.x), Math.abs(endY - target.y)) <= range) {
      const first = steps[0];
      if (first) step = new RoomPosition(creep.pos.x + first.dx, creep.pos.y + first.dy, creep.room.name);
    }
  }
  if (!step) step = approach(creep, target);
  if (step) intents.set(creep.name, { creep, next: step, priority: state.stuck });
}

/** Submit exactly one final move per participating creep after all work selection. */
export function flushTraffic(room: Room): void {
  prepare();
  const occupants: Record<string, string> = {};
  for (const creep of room.find(FIND_CREEPS)) occupants[key(creep.pos)] = creep.name;
  const local = [...intents.values()].filter(i => i.creep.room.name === room.name);
  const accepted = arbitrateMoves(local.map(i => ({ name: i.creep.name, from: key(i.creep.pos), to: key(i.next), priority: i.priority })), occupants);
  for (const intent of local) {
    if (accepted.has(intent.creep.name)) intent.creep.move(intent.creep.pos.getDirectionTo(intent.next));
    intents.delete(intent.creep.name);
  }
}
