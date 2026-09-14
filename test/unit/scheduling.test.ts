import { afterEach, expect, it, vi } from 'vitest';
import { runBootstrap } from '../../src/game/bootstrap';

afterEach(() => vi.unstubAllGlobals());

it('records heartbeat and capabilities even when execution must yield to CPU budget', () => {
  const memory = {} as Memory;
  vi.stubGlobal('Memory', memory);
  vi.stubGlobal('Game', { time: 1, rooms: {}, creeps: {}, cpu: { limit: 20, tickLimit: 500, getUsed: () => 19 }, gcl: { level: 2 } });
  runBootstrap();
  expect(memory.bootstrap?.heartbeat).toBe(1);
  expect(memory.bootstrap?.degraded).toBe(true);
  expect(memory.bootstrap?.capabilities?.gcl).toBe(2);
});

it('rotates room priority under pressure and retains unseen room capability as unknown', () => {
  vi.stubGlobal('FIND_MY_SPAWNS', 112);
  vi.stubGlobal('FIND_SOURCES', 105);
  vi.stubGlobal('FIND_MY_CREEPS', 102);
  const visited: string[] = [];
  let used = 0;
  const room = (name: string) => ({ name, controller: { my: true, level: 1 }, energyCapacityAvailable: 300, energyAvailable: 0,
    find: (kind: number) => { if (kind === 105) { visited.push(name); used = 19; } return []; } });
  const memory = {} as Memory;
  const game = { time: 1, rooms: { A: room('A'), B: room('B') }, creeps: {}, cpu: { limit: 20, tickLimit: 500, getUsed: () => used }, gcl: { level: 1 } };
  vi.stubGlobal('Memory', memory);
  vi.stubGlobal('Game', game);
  runBootstrap();
  used = 0;
  game.time++;
  runBootstrap();
  expect(visited).toEqual(['A', 'B']);
  expect(memory.bootstrap?.errors).toEqual([]);
  game.rooms = {} as typeof game.rooms;
  used = 0;
  game.time++;
  runBootstrap();
  expect(memory.bootstrap?.capabilities?.rooms.A?.visibility).toBe('unknown');
});
