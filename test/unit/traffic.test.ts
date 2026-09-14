import { expect, it } from 'vitest';
import { observeTraffic, type TrafficState } from '../../src/domain/traffic';

it('does not count work pauses, fatigue, or a changed destination as congestion', () => {
  const state = { x: 10, y: 10, tick: 1, target: 'mine', stuck: 19, failures: 0 };
  expect(observeTraffic(state, 10, 10, 30, 'mine', false).stuck).toBe(0);
  expect(observeTraffic(state, 10, 10, 2, 'mine', true).retryAt).toBeUndefined();
  expect(observeTraffic(state, 10, 10, 2, 'spawn', false).stuck).toBe(0);
});

it('backs off repeated blocked attempts, caps delay, and recovers after movement', () => {
  let state: TrafficState | undefined;
  let tick = 1;
  for (let failure = 0; failure < 8; failure++) {
    for (let attempt = 0; attempt <= 20; attempt++) state = observeTraffic(state, 10, 10, tick++, 'mine', false);
    expect(state!.retryAt).toBeDefined();
    expect(state!.retryAt! - state!.tick).toBeLessThanOrEqual(100);
    tick = state!.retryAt!;
  }
  const recovered = observeTraffic(state, 11, 10, tick, 'mine', false);
  expect(recovered.failures).toBe(0);
  expect(recovered.retryAt).toBeUndefined();
});
