import { expect, it } from 'vitest';
import { planEconomicTasks, recoverDependencies } from '../../src/domain/dependencies';

it('detects cycles and leaves independent work executable', () => {
  const result = recoverDependencies([
    { id: 'build', dependsOn: ['haul'], priority: 2, lastProgress: 0, retries: 0 },
    { id: 'haul', dependsOn: ['spawn'], priority: 3, lastProgress: 0, retries: 0 },
    { id: 'spawn', dependsOn: ['build'], priority: 4, lastProgress: 0, retries: 0 },
    { id: 'upgrade', dependsOn: [], priority: 1, lastProgress: 100, retries: 0 },
  ], 100);
  expect(result.cycles).toHaveLength(1);
  expect(result.blocked).toEqual(expect.arrayContaining(['build', 'haul', 'spawn']));
  expect(result.executable).toEqual(['upgrade']);
  expect(result.release).toEqual(['build', 'haul', 'spawn']);
});

it('waits for active or unknown prerequisites and releases at the deadline', () => {
  const tasks = [
    { id: 'a', dependsOn: ['b'], priority: 2, lastProgress: 10, retries: 0 },
    { id: 'b', dependsOn: [], priority: 1, lastProgress: 10, retries: 0 },
    { id: 'c', dependsOn: ['missing'], priority: 9, lastProgress: 10, retries: 0 },
  ];
  expect(recoverDependencies(tasks, 209).executable).toEqual(['b']);
  expect(recoverDependencies(tasks, 209).release).toEqual([]);
  expect(recoverDependencies(tasks, 210).release).toEqual(['a', 'c']);
});

it('groups overlapping cycles once and handles self dependencies', () => {
  const tasks = [['a', ['b', 'c']], ['b', ['a']], ['c', ['a']], ['d', ['d']]] as [string, string[]][];
  expect(recoverDependencies(tasks.map(([id, dependsOn]) => ({ id, dependsOn, priority: 0, lastProgress: 0, retries: 0 })), 1).cycles).toEqual([['a', 'b', 'c'], ['d']]);
});

it('keeps harvesting as an emergency escape from an economic cycle', () => {
  const result = planEconomicTasks([
    { id: 'harvest', kind: 'harvest', emergency: true, fallbackReady: true, dependsOn: ['haul'], priority: 1, lastProgress: 0, retries: 0 },
    { id: 'haul', kind: 'haul', dependsOn: ['spawn'], priority: 3, lastProgress: 0, retries: 0 },
    { id: 'spawn', kind: 'spawn', dependsOn: ['harvest'], priority: 4, lastProgress: 0, retries: 0 },
  ], 50);
  expect(result.emergency).toEqual(['harvest']);
  expect(result.decision.executable).toContain('harvest');
  expect(result.decision.cycles).toEqual([]);
  expect(result.decision.blocked).toEqual(['haul', 'spawn']);
});

it('never bypasses prerequisites without a verified fallback', () => {
  const result = planEconomicTasks([{ id: 'harvest', kind: 'harvest', emergency: true, dependsOn: ['missing-worker'], priority: 1, lastProgress: 0, retries: 0 }], 50);
  expect(result.emergency).toEqual([]);
  expect(result.decision.executable).toEqual([]);
});
