import { afterEach, expect, it, vi } from 'vitest';
import { LogisticsBoard } from '../../src/domain/logistics';
import { runLogistics } from '../../src/game/logistics';

afterEach(() => vi.unstubAllGlobals());

it('releases both reservations exactly once when a worker abandons its order', () => {
  const board = new LogisticsBoard([{ id: 'mine', amount: 50 }], [{ id: 'spawn', amount: 50, priority: 10 }]);
  board.reserve('blocked', 50, ['mine']);
  board.release('blocked');
  board.release('blocked');
  expect(board.reserve('replacement', 100, ['mine'])?.amount).toBe(50);
  expect(board.reserve('extra', 50, ['mine'])).toBeUndefined();
});

it('reconciles a retained destination against shrinking capacity and target loss', () => {
  const board = new LogisticsBoard([{ id: 'mine', amount: 100 }], [{ id: 'spawn', amount: 10, priority: 10 }]);
  expect(board.reserve('a', 50, ['mine'], 'gone')).toBeUndefined();
  expect(board.reserve('a', 50, ['mine'], 'spawn')?.amount).toBe(10);
});

it('reserves finite supply and destination space once per worker', () => {
  const board = new LogisticsBoard([{ id: 'mine', amount: 80 }], [{ id: 'spawn', amount: 60, priority: 10 }]);
  expect(board.reserve('a', 50, ['mine'])?.amount).toBe(50);
  expect(board.reserve('a', 50, ['mine'])?.amount).toBe(50);
  expect(board.reserve('b', 50, ['mine'])?.amount).toBe(10);
  expect(board.reserve('c', 50, ['mine'])).toBeUndefined();
});
it('prioritizes emergency delivery and rejects self-transfer cycles', () => {
  const board = new LogisticsBoard([{ id: 'mine', amount: 100 }], [{ id: 'mine', amount: 100, priority: 100 }, { id: 'upgrade', amount: 100, priority: 1 }, { id: 'spawn', amount: 25, priority: 10 }]);
  expect(board.reserve('a', 50, ['mine'])?.to).toBe('spawn');
  expect(board.reserve('b', 50, ['mine'])?.to).toBe('upgrade');
});
it('rebuilding after death or target loss frees reservations against current observations', () => {
  const old = new LogisticsBoard([{ id: 'mine', amount: 50 }], [{ id: 'spawn', amount: 50, priority: 10 }]);
  old.reserve('dead', 50, ['mine']);
  const current = new LogisticsBoard([{ id: 'mine', amount: 20 }], [{ id: 'replacement', amount: 30, priority: 10 }]);
  expect(current.reserve('alive', 50, ['mine'])).toEqual({ worker: 'alive', from: 'mine', to: 'replacement', amount: 20 });
});

it('keeps per-room task memory isolated when sibling rooms run on shared memory', () => {
  class Position {
    roomName: string;
    constructor(public x: number, public y: number, room: string) { this.roomName = room; }
    getRangeTo() { return 5; }
    isNearTo() { return false; }
  }
  vi.stubGlobal('Game', { time: 5000, creeps: {} });
  vi.stubGlobal('RoomPosition', Position);
  vi.stubGlobal('RESOURCE_ENERGY', 'energy');
  vi.stubGlobal('STRUCTURE_SPAWN', 'spawn');
  vi.stubGlobal('STRUCTURE_EXTENSION', 'extension');
  vi.stubGlobal('STRUCTURE_CONTAINER', 'container');
  vi.stubGlobal('FIND_MY_STRUCTURES', 1);
  vi.stubGlobal('FIND_MY_SPAWNS', 2);
  vi.stubGlobal('FIND_MY_CONSTRUCTION_SITES', 3);
  vi.stubGlobal('FIND_STRUCTURES', 4);
  const memory: { logisticsTasks?: Record<string, Record<string, unknown>> } = {};
  vi.stubGlobal('Memory', memory);
  const creep = (name: string) => ({
    name, spawning: false,
    memory: { shipment: { from: 'container', to: 'spawn-id', expires: 5200, waitingSince: 4990 } },
    store: { energy: 0, getUsedCapacity: () => 0, getFreeCapacity: () => 50 },
    pos: new Position(25, 25, name.endsWith('a') ? 'W0N1' : 'W0N2'),
  });
  const room = (name: string) => ({
    name,
    controller: { ticksToDowngrade: 20000 },
    find: (type: number) => type === 1 ? [{ structureType: 'spawn', id: 'spawn-id', store: { getFreeCapacity: () => 10 } }] : type === 2 ? [{ id: 'spawn-id' }] : [],
  });
  runLogistics(room('W0N1') as unknown as Room, [creep('worker-a')] as unknown as Creep[], [], {});
  runLogistics(room('W0N2') as unknown as Room, [creep('worker-b')] as unknown as Creep[], [], {});
  expect(Object.keys(memory.logisticsTasks ?? {}).sort()).toEqual(['W0N1', 'W0N2']);
  expect(Object.keys(memory.logisticsTasks?.W0N1 ?? {})).toContain('haul:worker-a');
  expect(Object.keys(memory.logisticsTasks?.W0N2 ?? {})).toContain('haul:worker-b');
  // A sibling room's cleanup must not wipe the other room's starvation history.
  runLogistics(room('W0N1') as unknown as Room, [creep('worker-a')] as unknown as Creep[], [], {});
  expect(Object.keys(memory.logisticsTasks?.W0N2 ?? {})).toContain('haul:worker-b');
});
