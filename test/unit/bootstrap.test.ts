import { expect, it } from 'vitest';
import { energyBudget, minerSpawnNeed, populationPlan, retryDelay, trackProgress } from '../../src/domain/bootstrap';

it('recovers with affordable bodies instead of waiting for room maximum', () => {
  const plan = populationPlan({ energy: 200, capacity: 600, sources: 2, workers: [], travel: 100, spawnBusy: false });
  expect(plan.spawn).toBe(true);
  expect(plan.cost).toBe(200);
});
it('replaces workers before their arrival deadline and respects busy spawns', () => {
  const input = { energy: 300, capacity: 300, sources: 1, workers: [{ ttl: 100, work: 1, spawning: false }, { ttl: 1400, work: 1, spawning: false }], travel: 100, spawnBusy: false };
  expect(populationPlan(input).spawn).toBe(true);
  expect(populationPlan({ ...input, spawnBusy: true }).spawn).toBe(false);
});
it('progress uses physical movement or inventory changes', () => {
  const first = trackProgress(undefined, 1, 1, 0);
  expect(trackProgress(first, 1, 1, 0).unchanged).toBe(1);
  expect(trackProgress(first, 1, 1, 2).unchanged).toBe(0);
});

it('caps configured storage targets by usable capacity without starving replacement', () => {
  expect(energyBudget(300, 600, 1000, 200)).toEqual({ reserve: 300, target: 300 });
  expect(energyBudget(600, 100, 200, 400)).toEqual({ reserve: 400, target: 400 });
  expect(energyBudget(600, 100, 300, 0)).toEqual({ reserve: 100, target: 300 });
});

it('backs off blocked work without an unbounded delay', () => {
  expect([3, 4, 5, 6, 100].map(retryDelay)).toEqual([25, 50, 100, 200, 200]);
});

it('spawns a dedicated miner only from surplus past the worker floor with a container seat', () => {
  const sources = [
    { id: 'a', hasContainer: true, minerAlive: false },
    { id: 'b', hasContainer: true, minerAlive: true },
  ];
  const base = { capacity: 800, energyAvailable: 650, workerCount: 6, workerSpawnPending: false, sources };
  expect(minerSpawnNeed(base)).toBe('a');
  expect(minerSpawnNeed({ ...base, capacity: 550 })).toBeUndefined();
  expect(minerSpawnNeed({ ...base, energyAvailable: 649 })).toBeUndefined();
  expect(minerSpawnNeed({ ...base, workerCount: 3 })).toBeUndefined();
  expect(minerSpawnNeed({ ...base, workerSpawnPending: true })).toBeUndefined();
  expect(minerSpawnNeed({ ...base, sources: sources.map(s => ({ ...s, minerAlive: true })) })).toBeUndefined();
  expect(minerSpawnNeed({ ...base, sources: [{ id: 'a', hasContainer: false, minerAlive: false }] })).toBeUndefined();
});
