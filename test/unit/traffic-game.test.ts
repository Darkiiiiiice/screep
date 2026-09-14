import { afterEach, expect, it, vi } from 'vitest';
import { flushTraffic, requestMove } from '../../src/game/traffic';

afterEach(() => vi.unstubAllGlobals());

it('defers movement and submits both sides of a swap exactly once', () => {
  class Position {
    roomName = 'W0N1';
    constructor(public x: number, public y: number) {}
    inRangeTo(target: Position, range: number) { return Math.max(Math.abs(this.x - target.x), Math.abs(this.y - target.y)) <= range; }
    findPathTo(target: Position) { return [target.x > this.x ? { dx: 1, dy: 0 } : { dx: -1, dy: 0 }]; }
    getDirectionTo(target: Position) { return target.x > this.x ? 3 : 7; }
  }
  const a = { name: 'swap-a', pos: new Position(10, 10), fatigue: 0, memory: {}, move: vi.fn(), room: { name: 'W0N1' } };
  const b = { name: 'swap-b', pos: new Position(11, 10), fatigue: 0, memory: {}, move: vi.fn(), room: { name: 'W0N1' } };
  vi.stubGlobal('Game', { time: 10000, creeps: { 'swap-a': a, 'swap-b': b } });
  vi.stubGlobal('RoomPosition', Position);
  vi.stubGlobal('FIND_CREEPS', 101);
  requestMove(a as unknown as Creep, b.pos as RoomPosition, 0);
  requestMove(b as unknown as Creep, a.pos as RoomPosition, 0);
  expect(a.move).not.toHaveBeenCalled();
  const room = { name: 'W0N1', find: () => [a, b] } as unknown as Room;
  flushTraffic(room);
  flushTraffic(room);
  expect(a.move).toHaveBeenCalledExactlyOnceWith(3);
  expect(b.move).toHaveBeenCalledExactlyOnceWith(7);
});

it('holds position when no reachable route strictly shortens the distance', () => {
  class Position {
    roomName = 'W0N1';
    constructor(public x: number, public y: number) {}
    inRangeTo(target: Position, range: number) { return Math.max(Math.abs(this.x - target.x), Math.abs(this.y - target.y)) <= range; }
    findPathTo() { return []; }
    getDirectionTo() { return 1; }
  }
  const sealed = {
    name: 'sealed', pos: new Position(5, 5), fatigue: 0, memory: {}, move: vi.fn(),
    room: { name: 'W0N1', lookAt: () => [{ type: 'terrain', terrain: 'wall' }] },
  };
  const target = new Position(5, 8);
  vi.stubGlobal('Game', { time: 20000, creeps: { sealed } });
  vi.stubGlobal('RoomPosition', Position);
  vi.stubGlobal('FIND_CREEPS', 101);
  requestMove(sealed as unknown as Creep, target as unknown as RoomPosition, 0);
  flushTraffic({ name: 'W0N1', find: () => [sealed] } as unknown as Room);
  expect(sealed.move).not.toHaveBeenCalled();
});
