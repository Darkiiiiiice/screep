import { afterEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { guard, record, recentErrors, clearErrors, errorCounts } from '@/kernel/errors';

let engine: FakeEngine | undefined;

afterEach(() => {
  engine?.restore();
  engine = undefined;
});

/** An error whose stack names a stable throw site. */
function makeError(name: string, site: string): Error {
  const err = new Error('boom');
  err.name = name;
  err.stack = `${name}: boom\n    at ${site} (main.js:1:1)`;
  return err;
}

describe('guard', () => {
  it('returns the value when the call succeeds', () => {
    engine = installFakeEngine();
    expect(guard(() => 5, 'thing')).toBe(5);
  });

  it('contains a throw and returns undefined instead of propagating', () => {
    // An exception escaping loop() aborts the whole tick for every creep, so
    // containment here is what keeps one bad operation from costing all of them.
    engine = installFakeEngine();
    expect(guard(() => {
      throw new Error('boom');
    }, 'thing')).toBeUndefined();
  });

  it('records the failure so it is still visible', () => {
    engine = installFakeEngine();
    guard(() => {
      throw makeError('TypeError', 'doWork');
    }, 'thing');
    expect(recentErrors()).toHaveLength(1);
  });
});

describe('error reporting', () => {
  it('keeps every occurrence in the ring while throttling the console', () => {
    // The ring is the complete record for post-mortem; the console is a
    // summary. A repeated failure must not be lost just because its line was
    // throttled — otherwise a chronic bug looks like a single event.
    engine = installFakeEngine();
    record(makeError('Error', 'atFoo'), 'op');
    record(makeError('Error', 'atFoo'), 'op');
    record(makeError('Error', 'atFoo'), 'op');

    expect(recentErrors()).toHaveLength(3);
    expect(errorCounts()).toEqual({ 'Error@atFoo': 3 });
    expect(engine.logs.filter((l) => l.includes('failed:'))).toHaveLength(1);
  });

  it('treats different throw sites as different problems', () => {
    engine = installFakeEngine();
    record(makeError('Error', 'atFoo'), 'op');
    record(makeError('Error', 'atBar'), 'op');
    expect(engine.logs.filter((l) => l.includes('failed:'))).toHaveLength(2);
    expect(Object.keys(errorCounts()).sort()).toEqual(['Error@atBar', 'Error@atFoo']);
  });

  it('retains only the most recent errors, bounded', () => {
    engine = installFakeEngine();
    for (let i = 0; i < 30; i += 1) {
      record(makeError('Error', `site${i}`), 'op');
    }
    expect(recentErrors()).toHaveLength(20);
    // Newest last: the ring drops the oldest, not the newest.
    expect(recentErrors().at(-1)?.site).toContain('site29');
  });

  it('handles a thrown non-Error without crashing the handler', () => {
    engine = installFakeEngine();
    record('just a string', 'op');
    expect(recentErrors()).toHaveLength(1);
  });

  it('clears on demand after a review', () => {
    engine = installFakeEngine();
    record(makeError('Error', 'atFoo'), 'op');
    clearErrors();
    expect(recentErrors()).toEqual([]);
    expect(errorCounts()).toEqual({});
  });
});
