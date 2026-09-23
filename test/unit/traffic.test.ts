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

it('continues the same stuck episode across a side-step anchor, resets beyond it', () => {
  const anchored: TrafficState = { x: 10, y: 10, tick: 40, target: 'mine', stuck: 0, failures: 1, retryAt: 50, anchorX: 10, anchorY: 10 };
  // 侧移后醒来：物理位置偏 1 格，锚点同目标 -> 同一卡死段落；退避期间 tick 断档，stuck 从醒来重算
  const resumed = observeTraffic(anchored, 11, 10, 51, 'mine', false);
  expect(resumed.stuck).toBe(0);
  expect(resumed.failures).toBe(1);
  expect(resumed.anchorX).toBe(10);
  // 醒来后继续卡在同一锚点邻域 -> stuck 继续累积
  expect(observeTraffic(resumed, 11, 10, 52, 'mine', false).stuck).toBe(1);
  expect(resumed.failures).toBe(1);
  expect(resumed.anchorX).toBe(10);
  // 锚点目标不同 -> 新段落
  expect(observeTraffic(anchored, 11, 10, 51, 'spawn', false).stuck).toBe(0);
  // 离锚点超过 1 格 -> 真的走出来了，计数清零且锚点脱落
  const free = observeTraffic(resumed, 13, 10, 52, 'mine', false);
  expect(free.stuck).toBe(0);
  expect(free.failures).toBe(0);
  expect(free.anchorX).toBeUndefined();
});
