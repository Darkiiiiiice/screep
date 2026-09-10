import { afterEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { log } from '@/kernel/log';

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

  it('suppresses repeated occurrences within the interval', () => {
    // A retry loop failing every tick would otherwise emit a line per tick,
    // burning the CPU budget that the fix needs.
    engine = installFakeEngine();
    for (let i = 0; i < 10; i += 1) log('warn', 'sig', `attempt ${String(i)}`);

    expect(engine.logs).toHaveLength(1);
  });

  it('reports the dropped count on the next emission of that signature', () => {
    // Bounded output: the count arrives attached to the line it describes
    // instead of as a per-tick summary, which would be more noise than the
    // messages it replaced. (An earlier version did exactly that and flooded the
    // live console with `(+1 suppressed)` every tick.)
    engine = installFakeEngine();
    log('warn', 'sig', 'first');

    for (let i = 0; i < 10; i += 1) {
      engine.advanceTick();
      log('warn', 'sig', 'duplicate');
    }
    // Let the interval elapse without logging, so the next call emits.
    for (let i = 0; i < 21; i += 1) engine.advanceTick();
    log('warn', 'sig', 'again');

    expect(engine.logs).toHaveLength(2);
    expect(engine.logs[1]).toContain('again');
    expect(engine.logs[1]).toContain('(+10 suppressed)');
  });

  it('does not mention a single dropped duplicate', () => {
    // One suppressed repeat is not information worth spending console budget on.
    engine = installFakeEngine();
    log('warn', 'sig', 'first');
    engine.advanceTick();
    log('warn', 'sig', 'duplicate');

    for (let i = 0; i < 26; i += 1) engine.advanceTick();
    log('warn', 'sig', 'again');

    expect(engine.logs[1]).toContain('again');
    expect(engine.logs[1]).not.toContain('suppressed');
  });

  it('clears the backlog after reporting it, so it is not repeated', () => {
    engine = installFakeEngine();
    log('warn', 'sig', 'first');
    for (let i = 0; i < 10; i += 1) {
      engine.advanceTick();
      log('warn', 'sig', 'duplicate');
    }
    for (let i = 0; i < 21; i += 1) engine.advanceTick();
    log('warn', 'sig', 'second'); // reports the backlog of 10

    for (let i = 0; i < 26; i += 1) engine.advanceTick();
    log('warn', 'sig', 'third'); // nothing new was dropped

    expect(engine.logs[1]).toContain('(+10 suppressed)');
    expect(engine.logs[2]).toContain('third');
    expect(engine.logs[2]).not.toContain('suppressed');
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
    // Nothing else is printed to compensate: silence is the correct outcome, and
    // the count surfaces on those signatures' next emission.
    expect(engine.logs.every((l) => l.includes('boom'))).toBe(true);
  });

  it('resets the per-tick line budget on the next tick', () => {
    engine = installFakeEngine();
    for (let i = 0; i < 50; i += 1) log('error', `sig${String(i)}`, 'boom');
    const firstTick = engine.logs.length;

    engine.advanceTick();
    log('error', 'fresh', 'new tick');
    expect(engine.logs.length).toBe(firstTick + 1);
  });

  it('includes the level for non-info output', () => {
    engine = installFakeEngine();
    log('error', 'sig', 'bad');
    expect(engine.logs[0]).toContain('[error]');
  });

  it('drops signatures too old to suppress anything, so the table stays bounded', () => {
    // A long-lived runtime must not accumulate a signature per distinct message
    // ever seen; entries that can no longer suppress are unreachable state.
    engine = installFakeEngine();
    log('warn', 'old', 'first');

    // Past SIGNATURE_INTERVAL * 4, the entry is pruned on the next tick.
    for (let i = 0; i < 200; i += 1) engine.advanceTick();
    log('warn', 'old', 'again');

    expect(engine.logs).toHaveLength(2);
    expect(engine.logs[1]).not.toContain('suppressed');
  });
});
