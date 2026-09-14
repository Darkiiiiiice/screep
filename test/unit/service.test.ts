import { expect, it } from 'vitest';
import { rankServices, settleService, type ServiceState } from '../../src/domain/service';
import { LogisticsBoard } from '../../src/domain/logistics';

it('serves every continuously competing consumer with scarce supply across 2000 ticks', () => {
  let states: Record<string, ServiceState> = {};
  const candidates = [{ id: 'spawn', priority: 10, emergency: false }, { id: 'extension-a', priority: 5, emergency: false }, { id: 'extension-b', priority: 5, emergency: false }];
  const last: Record<string, number> = Object.fromEntries(candidates.map(c => [c.id, 0]));
  const counts: Record<string, number> = { spawn: 0, 'extension-a': 0, 'extension-b': 0 };
  for (let tick = 0; tick < 2000; tick++) {
    if (tick % 53 === 0) states = JSON.parse(JSON.stringify(states));
    const ranked = rankServices(candidates, states, tick);
    if (tick % 10 === 0) {
      const board = new LogisticsBoard([{ id: 'mine', amount: 1 }], ranked.map((c, index) => ({ id: c.id, amount: 50, priority: ranked.length - index })));
      const order = board.reserve('hauler', 1, ['mine'])!;
      settleService(states, order.to, tick);
      last[order.to] = tick; counts[order.to]!++;
    }
    for (const c of candidates) expect(tick - last[c.id]!).toBeLessThanOrEqual(200);
  }
  expect(Object.values(counts).every(count => count >= 10)).toBe(true);
});

it('does not reset waiting on dispatch, expires leases, and prioritizes survival', () => {
  const states: Record<string, ServiceState> = {};
  const low = { id: 'low', priority: 1, emergency: false };
  rankServices([low], states, 0);
  const high = { id: 'high', priority: 10, emergency: false };
  expect(rankServices([low, high], states, 24)[0]!.id).toBe('low');
  expect(rankServices([low, high], states, 25)[0]!.id).toBe('high');
  expect(states.low!.waitingSince).toBe(0);
  expect(rankServices([low, { ...high, emergency: true }], states, 1000)[0]!.id).toBe('high');
  rankServices([high], states, 1001);
  expect(states.low).toBeUndefined();
});
