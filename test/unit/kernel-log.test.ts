import { afterEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { log, flushLogSummary } from '@/kernel/log';

let engine: FakeEngine | undefined;

afterEach(() => {
  engine?.restore();
  engine = undefined;
});

describe('log throttling', () => {
  it('emits the first occurrence of a signature', () => {
    engine = installFakeEngine();
    log('info', 'sig', 'hello');
    expect(engine.logs).toHaveLength(1);
    expect(engine.logs[0]).toContain('hello');
  });

  it('suppresses a repeated signature within the interval', () => {
    // A retry loop failing every tick would otherwise emit a line per tick,
    // burning the CPU budget that the fix needs.
    engine = installFakeEngine();
    for (let i = 0; i < 10; i += 1) log('warn', 'sig', `attempt ${String(i)}`);

    // One real line plus the summary that reports the rest.
    expect(engine.logs).toHaveLength(1);
    flushLogSummary();
    expect(engine.logs[1]).toContain('(+9 suppressed)');
  });

  it('lets the same signature through once the interval has elapsed', () => {
    engine = installFakeEngine();
    log('warn', 'sig', 'first');
    for (let i = 0; i < 25; i += 1) engine.advanceTick();
    log('warn', 'sig', 'again');

    expect(engine.logs).toHaveLength(2);
    expect(engine.logs[1]).toContain('again');
  });

  it('treats distinct signatures independently', () => {
    engine = installFakeEngine();
    log('warn', 'a', 'from a');
    log('warn', 'b', 'from b');
    expect(engine.logs).toHaveLength(2);
  });

  it('caps total lines per tick so one broad failure cannot flood', () => {
    // Distinct signatures bypass the per-signature throttle, so a broad failure
    // (every creep erroring) needs the second throttle to stay bounded.
    engine = installFakeEngine();
    for (let i = 0; i < 50; i += 1) log('error', `sig${String(i)}`, 'boom');

    expect(engine.logs.length).toBeLessThanOrEqual(8);
    flushLogSummary();
    expect(engine.logs.at(-1)).toMatch(/\(\+\d+ suppressed\)/);
  });

  it('resets the per-tick line budget on the next tick', () => {
    engine = installFakeEngine();
    for (let i = 0; i < 50; i += 1) log('error', `sig${String(i)}`, 'boom');
    const firstTick = engine.logs.length;

    engine.advanceTick();
    log('error', 'fresh', 'new tick');
    expect(engine.logs.length).toBe(firstTick + 1);
  });

  it('stays silent when nothing was suppressed', () => {
    engine = installFakeEngine();
    log('info', 'sig', 'only line');
    flushLogSummary();
    expect(engine.logs).toHaveLength(1);
  });

  it('includes level in the line for non-info output', () => {
    engine = installFakeEngine();
    log('error', 'sig', 'bad');
    expect(engine.logs[0]).toContain('[error]');
  });
});
