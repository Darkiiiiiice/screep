import { afterEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { kernelTick, tickBudget, PHASES } from '@/kernel/tick';
import { STATS_SEGMENT } from '@/kernel/stats';

let engine: FakeEngine | undefined;

afterEach(() => {
  engine?.restore();
  engine = undefined;
});

/** Phases the kernel reported as skipped this tick, parsed from its output. */
function skippedPhases(e: FakeEngine): string[] {
  const line = e.logs.find((l) => l.includes('skipped='));
  if (!line) return [];
  return (line.split('skipped=')[1] ?? '').split(',').filter(Boolean);
}

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

describe('degradation policy', () => {
  it('skips exactly the low-priority phases under CPU pressure', () => {
    // Working budget is 20 * (1 - 0.12) = 17.6 ms, degrading above 80% of it
    // (14.08 ms). Spending 19 ms must drop the scans and keep the phases whose
    // failure costs more than a missed scan.
    engine = installFakeEngine();
    engine.spend(19);
    kernelTick();
    expect(skippedPhases(engine)).toEqual(['prefetch', 'intel', 'plan', 'execute']);
  });

  it('degrades before the engine cuts the script off', () => {
    // Degradation must trigger strictly below the hard limit; a tick that only
    // reacts at 100% has already lost work to the engine's own cutoff.
    engine = installFakeEngine({ cpuLimit: 20 });
    engine.spend(15); // above the 14.08 threshold, below the 20 hard limit
    kernelTick();
    expect(skippedPhases(engine)).not.toEqual([]);
  });

  it('runs the full pipeline when CPU is plentiful', () => {
    engine = installFakeEngine();
    kernelTick();
    expect(skippedPhases(engine)).toEqual([]);
  });

  it('keeps cleanup running under pressure, so its effects still land', () => {
    // Cleanup is the phase whose loss corrupts the *next* tick, so verify the
    // effect rather than the intent: the stats segment must still be written.
    engine = installFakeEngine();
    engine.spend(19);
    kernelTick();

    expect(skippedPhases(engine)).not.toContain('cleanup');
    expect(engine.rawMemory.segments[STATS_SEGMENT]).toBeDefined();
  });

  it('reclaims dead creeps even under CPU pressure', () => {
    engine = installFakeEngine();
    engine.memory.creeps = { Alive: {}, Dead: {} };
    engine.game.creeps = { Alive: {} };

    engine.spend(19);
    kernelTick();

    const creeps = engine.memory.creeps as Record<string, unknown>;
    expect(creeps.Alive).toBeDefined();
    expect(creeps.Dead).toBeUndefined();
  });

  it('restores the full pipeline on the next tick', () => {
    engine = installFakeEngine();
    engine.spend(19);
    kernelTick();
    expect(skippedPhases(engine)).not.toEqual([]);

    engine.advanceTick();
    engine.logs.length = 0;
    kernelTick();
    expect(skippedPhases(engine)).toEqual([]);
  });
});

describe('pipeline invariants', () => {
  it('orders phases so a creep born this tick can be assigned this tick', () => {
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
