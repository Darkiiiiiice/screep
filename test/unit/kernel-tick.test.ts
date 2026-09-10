import { afterEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { kernelTick, tickBudget, PHASES } from '@/kernel/tick';

let engine: FakeEngine | undefined;

afterEach(() => {
  engine?.restore();
  engine = undefined;
});

describe('tickBudget', () => {
  it('uses the account baseline, not the bucket-inflated limit, when the bucket is full', () => {
    // A full bucket lets one tick borrow up to 500 CPU. Spending that in a
    // single tick would stall every other player in the shard, so the working
    // budget must stay pinned to the account baseline.
    engine = installFakeEngine({ cpuLimit: 20, cpuTickLimit: 520 });
    expect(tickBudget()).toBe(20);
  });

  it('falls back to tickLimit when it is below the baseline', () => {
    engine = installFakeEngine({ cpuLimit: 300, cpuTickLimit: 20 });
    expect(tickBudget()).toBe(20);
  });

  it('defaults to the un-unlocked official limit of 20 CPU', () => {
    engine = installFakeEngine();
    expect(tickBudget()).toBe(20);
  });
});

describe('kernelTick', () => {
  it('stays silent when the whole pipeline fits the budget', () => {
    engine = installFakeEngine();
    kernelTick();
    expect(engine.logs).toEqual([]);
  });

  it('skips exactly the low-priority phases under CPU pressure', () => {
    // Working budget is 20 * (1 - 0.12) = 17.6 ms, degrading above 80% of it
    // (14.08 ms). Spending 19 ms must drop prefetch/intel/plan/execute while
    // keeping spawn/assign/cleanup — losing a spawn or a memory GC costs more
    // than losing a scan.
    engine = installFakeEngine();
    engine.spend(19);
    kernelTick();
    expect(engine.logs).toEqual([
      '[kernel] tick=1 cpu=19.0/17.6 skipped=prefetch,intel,plan,execute',
    ]);
  });

  it('degrades before the engine cuts the script off', () => {
    // Degradation must trigger strictly below the hard limit; a tick that only
    // reacts at 100% has already lost work to the engine's own cutoff.
    engine = installFakeEngine({ cpuLimit: 20 });
    engine.spend(15); // > 14.08 threshold, < 20 hard limit
    kernelTick();
    expect(engine.logs).toHaveLength(1);
  });

  it('restores the full pipeline on the next tick', () => {
    engine = installFakeEngine();
    engine.spend(19);
    kernelTick();
    expect(engine.logs).toHaveLength(1);

    engine.advanceTick();
    kernelTick();
    expect(engine.logs).toHaveLength(1); // no second skip report
  });

  it('orders the pipeline so a creep born this tick can be assigned this tick', () => {
    expect(PHASES).toEqual([
      'prefetch',
      'intel',
      'plan',
      'spawn',
      'assign',
      'execute',
      'cleanup',
    ]);
    expect(PHASES.indexOf('spawn')).toBeLessThan(PHASES.indexOf('assign'));
    expect(PHASES.at(-1)).toBe('cleanup');
  });
});
