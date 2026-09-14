import { expect, it } from 'vitest';
import { planEconomy } from '../../src/domain/economy';

it('records haul, build, spawn, and upgrade nodes in one graph', () => {
  const plan = planEconomy({
    now: 5,
    haulers: [{ name: 'w1', carrying: false, retries: 0 }],
    sites: [{ id: 'site1', needsEnergy: true, suppliers: [] }],
    spawn: { room: 'W0N1', waiting: false, suppliers: [] },
    upgrade: { room: 'W0N1', worker: 'w1' },
  });
  expect(plan.tasks.map(task => task.id).sort()).toEqual(['build:site1', 'haul:w1', 'spawn:W0N1', 'upgrade:W0N1']);
  expect(plan.decision.blocked).toEqual([]);
});

it('blocks construction on inbound haul deliveries until they settle', () => {
  const plan = planEconomy({
    now: 5,
    haulers: [{ name: 'h1', carrying: true, waitingSince: 5, retries: 0, shipment: { to: 'site1', expires: 100 } }],
    sites: [{ id: 'site1', needsEnergy: true, suppliers: ['h1'] }],
  });
  expect(plan.decision.blocked).toEqual(['build:site1']);
  expect(plan.tasks.find(task => task.id === 'build:site1')!.dependsOn).toEqual(['haul:h1']);
});

it('maps bare shipment dependencies to haul tasks and keeps cross-kind ids raw', () => {
  const plan = planEconomy({
    now: 5,
    haulers: [{ name: 'h1', carrying: false, retries: 0, shipment: { to: 'x', expires: 100, dependsOn: ['h2', 'build:site9'] } }],
    sites: [{ id: 'site9', needsEnergy: true, suppliers: [] }],
  });
  expect(plan.tasks.find(task => task.id === 'haul:h1')!.dependsOn).toEqual(['haul:h2', 'build:site9']);
  expect(plan.decision.blocked).toEqual(['haul:h1']);
});

it('treats an affordable spawn as executable and a starved spawn as waiting on inbound cargo', () => {
  const affordable = planEconomy({
    now: 5,
    haulers: [{ name: 'h1', carrying: false, retries: 0 }],
    sites: [],
    spawn: { room: 'W0N1', waiting: false, suppliers: [] },
  });
  expect(affordable.decision.blocked).toEqual([]);
  const starved = planEconomy({
    now: 5,
    haulers: [{ name: 'h1', carrying: true, waitingSince: 5, retries: 0, shipment: { to: 'spawn-1', expires: 100 } }],
    sites: [],
    spawn: { room: 'W0N1', waiting: true, suppliers: ['h1'] },
  });
  expect(starved.decision.blocked).toContain('spawn:W0N1');
});

it('releases a spawn starved past the wait limit for escalation', () => {
  const plan = planEconomy({
    now: 200,
    prior: { 'spawn:W0N1': { lastProgress: 50 } },
    haulers: [{ name: 'h1', carrying: true, waitingSince: 190, retries: 0, shipment: { to: 'spawn-1', expires: 400 } }],
    sites: [],
    spawn: { room: 'W0N1', waiting: true, suppliers: ['h1'] },
  });
  expect(plan.decision.release).toContain('spawn:W0N1');
});

it('detects a cycle where a haul waits on a build that waits on the haul', () => {
  const plan = planEconomy({
    now: 5,
    haulers: [{ name: 'h1', carrying: false, retries: 0, shipment: { to: 'site1', expires: 100, dependsOn: ['build:site1'] } }],
    sites: [{ id: 'site1', needsEnergy: true, suppliers: ['h1'] }],
  });
  expect(plan.decision.cycles[0]?.slice().sort()).toEqual(['build:site1', 'haul:h1']);
  expect(plan.decision.release).toContain('haul:h1');
});
