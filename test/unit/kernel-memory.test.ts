import { afterEach, describe, expect, it } from 'vitest';
import { installFakeEngine, type FakeEngine } from '../fixtures/engine';
import { initMemory, gcDeadCreeps, memoryBytes, MEMORY_VERSION } from '@/kernel/memory';

let engine: FakeEngine | undefined;

afterEach(() => {
  engine?.restore();
  engine = undefined;
});

describe('memory migration', () => {
  it('stamps the schema version and creates the containers on first run', () => {
    engine = installFakeEngine();
    const mem = initMemory();
    expect(mem.version).toBe(MEMORY_VERSION);
    expect(mem.creeps).toEqual({});
    expect(mem.tasks).toEqual({});
  });

  it('is idempotent — a tick cut off mid-migration must be safe to re-run', () => {
    // The CPU limit can interrupt a tick at any point and the engine does not
    // roll back, so a migration that is not idempotent corrupts Memory.
    engine = installFakeEngine();
    initMemory();
    engine.memory.creeps = { Bob: { role: 'harvester' } };

    const mem = initMemory();
    expect(mem.version).toBe(MEMORY_VERSION);
    expect(mem.creeps).toEqual({ Bob: { role: 'harvester' } });
  });

  it('is a no-op on the fast path once migrated', () => {
    engine = installFakeEngine();
    initMemory();
    engine.logs.length = 0;
    initMemory();
    // No migration line: the common case must not log every tick.
    expect(engine.logs).toEqual([]);
  });
});

describe('dead creep GC', () => {
  it('reclaims entries for creeps that no longer exist and keeps live ones', () => {
    engine = installFakeEngine();
    initMemory();
    engine.memory.creeps = { Alive: {}, Dead1: {}, Dead2: {} };
    engine.game.creeps = { Alive: {} };

    expect(gcDeadCreeps()).toBe(2);
    expect(Object.keys(engine.memory.creeps as object)).toEqual(['Alive']);
  });

  it('collects incrementally so a mass death does not spike one tick', () => {
    // Reclaiming every dead creep at once is a visible CPU spike exactly when a
    // wave of creeps dies; the leftover is collected on following ticks.
    engine = installFakeEngine();
    initMemory();
    engine.memory.creeps = { D1: {}, D2: {}, D3: {}, D4: {}, D5: {} };
    engine.game.creeps = {};

    expect(gcDeadCreeps(2)).toBe(2);
    expect(Object.keys(engine.memory.creeps as object)).toHaveLength(3);

    engine.advanceTick();
    expect(gcDeadCreeps(2)).toBe(2);
    engine.advanceTick();
    expect(gcDeadCreeps(2)).toBe(1);
    expect(Object.keys(engine.memory.creeps as object)).toHaveLength(0);
  });

  it('tolerates a Memory without a creeps container', () => {
    engine = installFakeEngine();
    engine.memory.version = MEMORY_VERSION;
    delete engine.memory.creeps;
    expect(gcDeadCreeps()).toBe(0);
  });
});

describe('memoryBytes', () => {
  it('reports the serialized size, which is what the 2 MB cap applies to', () => {
    engine = installFakeEngine();
    engine.memory.payload = 'x'.repeat(100);
    expect(memoryBytes()).toBe(JSON.stringify(engine.memory).length);
  });
});
