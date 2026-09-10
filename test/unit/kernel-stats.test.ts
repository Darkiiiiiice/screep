import { afterEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { STATS_SEGMENT, maybeWriteStats } from '@/kernel/stats';
import { profilePhase, profileSnapshot, maybeReportProfile } from '@/kernel/profiler';

let engine: FakeEngine | undefined;

afterEach(() => {
  engine?.restore();
  engine = undefined;
});

function segmentHistory(e: FakeEngine): unknown[] {
  const raw = e.rawMemory.segments[STATS_SEGMENT];
  return raw ? (JSON.parse(raw) as unknown[]) : [];
}

describe('stats segment', () => {
  it('writes on the first tick', () => {
    engine = installFakeEngine();
    maybeWriteStats();
    expect(segmentHistory(engine)).toHaveLength(1);
  });

  it('does not write every tick', () => {
    // RawMemory.set plus JSON.stringify every tick is real CPU spent producing
    // data nobody reads that fast.
    engine = installFakeEngine();
    maybeWriteStats();
    engine.advanceTick();
    maybeWriteStats();
    expect(segmentHistory(engine)).toHaveLength(1);
  });

  it('writes again once the interval has elapsed', () => {
    engine = installFakeEngine();
    maybeWriteStats();
    for (let i = 0; i < 50; i += 1) engine.advanceTick();
    maybeWriteStats();
    expect(segmentHistory(engine)).toHaveLength(2);
  });

  it('bounds retained history', () => {
    engine = installFakeEngine();
    for (let i = 0; i < 30; i += 1) {
      maybeWriteStats();
      for (let t = 0; t < 50; t += 1) engine.advanceTick();
    }
    expect(segmentHistory(engine)).toHaveLength(20);
  });

  it('records the constraints that matter: CPU, creeps, memory size', () => {
    engine = installFakeEngine();
    engine.game.creeps = { A: {}, B: {} };
    engine.memory.payload = 'x'.repeat(50);
    maybeWriteStats();

    const [sample] = segmentHistory(engine) as [Record<string, unknown>];
    expect(sample.creeps).toBe(2);
    expect(sample.cpu).toMatchObject({ limit: 20 });
    expect(sample.memoryBytes).toBeGreaterThan(50);
  });

  it('counts only rooms we control and reports the highest RCL', () => {
    engine = installFakeEngine();
    engine.game.rooms = {
      W1N1: { controller: { my: true, level: 3 } },
      W2N2: { controller: { my: true, level: 5 } },
      W3N3: { controller: { my: false, level: 8 } },
      W4N4: {},
    };
    maybeWriteStats();

    const [sample] = segmentHistory(engine) as [Record<string, unknown>];
    expect(sample.rooms).toBe(2);
    expect(sample.rcl).toBe(5);
  });

  it('recovers from a corrupt segment instead of throwing', () => {
    // A truncated segment must not break the tick that tries to append to it.
    engine = installFakeEngine();
    engine.rawMemory.segments[STATS_SEGMENT] = '{not json';
    maybeWriteStats();
    expect(segmentHistory(engine)).toHaveLength(1);
  });
});

describe('profiler', () => {
  it('measures CPU charged inside the profiled call', () => {
    engine = installFakeEngine();
    profilePhase('work', () => engine?.spend(3));
    expect(profileSnapshot().work).toBe(3);
  });

  it('reports the running mean, not the last sample', () => {
    // A single tick's number is noise; the mean is what tuning acts on.
    engine = installFakeEngine();
    profilePhase('work', () => engine?.spend(2));
    engine?.advanceTick();
    profilePhase('work', () => engine?.spend(4));
    expect(profileSnapshot().work).toBe(3);
  });

  it('still records the sample when the profiled call throws', () => {
    engine = installFakeEngine();
    expect(() =>
      profilePhase('work', () => {
        engine?.spend(1);
        throw new Error('boom');
      }),
    ).toThrow();
    expect(profileSnapshot().work).toBe(1);
  });

  it('reports on an interval rather than every tick', () => {
    engine = installFakeEngine();
    profilePhase('work', () => undefined);

    // The interval is measured in calls: the kernel calls this once per tick.
    let reported = false;
    for (let i = 0; i < 100; i += 1) {
      engine.advanceTick();
      if (maybeReportProfile()) reported = true;
    }

    expect(reported).toBe(true);
    expect(engine.logs.some((l) => l.includes('cpu/phase'))).toBe(true);
  });
});
