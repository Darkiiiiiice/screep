import { expect, it } from 'vitest';
import { intelState } from '../../src/game/intel';
import {
  INTEL_CAP,
  INTEL_STALE,
  UNREACHABLE_TTL,
  isReachable,
  isStale,
  markUnreachable,
  nextScoutTarget,
  observe,
  pruneIntel,
  pruneUnreachable,
  shouldSpawnScout,
  threatActive,
  type IntelMemory,
  type RoomIntel,
} from '../../src/domain/intel';
const intelAt = (observedAt: number, hostiles = 0): RoomIntel => ({
  observedAt,
  sources: [],
  threat: { hostiles, armed: 0, towers: 0, keeperLairs: 0 },
});

it('treats missing or aged observation as stale, fresh as current', () => {
  expect(isStale(undefined, 100)).toBe(true);
  expect(isStale(intelAt(0), INTEL_STALE - 1)).toBe(false);
  expect(isStale(intelAt(0), INTEL_STALE)).toBe(true);
});

it('reports threat only when observation is fresh, never on lost visibility', () => {
  expect(threatActive(intelAt(100, 2), 200)).toBe(true);
  expect(threatActive(intelAt(100, 2), 100 + INTEL_STALE)).toBe(false);
  expect(threatActive(intelAt(100, 0), 200)).toBe(false);
  expect(threatActive(undefined, 200)).toBe(false);
});

it('scouts never-observed rooms before refreshing the stalest one', () => {
  const rooms = { W0N2: intelAt(50), W0N3: intelAt(10) };
  const candidates = ['W0N2', 'W0N3', 'W1N1'];
  expect(nextScoutTarget(candidates, rooms, 100)).toBe('W1N1');
  expect(nextScoutTarget(candidates, rooms, 100 + INTEL_STALE)).toBe('W1N1');
  const allSeen = { W0N2: intelAt(50), W0N3: intelAt(10) };
  expect(nextScoutTarget(['W0N2', 'W0N3'], allSeen, 60)).toBeUndefined();
  expect(nextScoutTarget(['W0N2', 'W0N3'], allSeen, INTEL_STALE + 50)).toBe('W0N3');
});

it('spawns a scout only past bootstrap on a full spawn without competing demand or recent death', () => {
  const base = { scoutsAlive: 0, targetAvailable: true, workerSpawnPending: false, energyAvailable: 300, controllerLevel: 3, now: 1000, lastScoutDeathAt: 800 };
  expect(shouldSpawnScout(base)).toBe(true);
  expect(shouldSpawnScout({ ...base, scoutsAlive: 1 })).toBe(false);
  expect(shouldSpawnScout({ ...base, targetAvailable: false })).toBe(false);
  expect(shouldSpawnScout({ ...base, workerSpawnPending: true })).toBe(false);
  expect(shouldSpawnScout({ ...base, controllerLevel: 1 })).toBe(false);
  expect(shouldSpawnScout({ ...base, energyAvailable: 299 })).toBe(false);
  expect(shouldSpawnScout({ ...base, lastScoutDeathAt: 950 })).toBe(false);
  expect(shouldSpawnScout({ ...base, lastScoutDeathAt: undefined })).toBe(true);
});

it('resets legacy schema-less intel memory instead of deadlocking (v1 residue)', () => {
  (globalThis as Record<string, unknown>).Memory = { intel: {} };
  const state = intelState();
  expect(state.schema).toBe(1);
  expect(state.rooms).toEqual({});
  expect(((globalThis as Record<string, unknown>).Memory as { intel: { schema: number } }).intel.schema).toBe(1);
  delete (globalThis as Record<string, unknown>).Memory;
});

it('blacklists unreachable targets for a bounded ttl, then allows retry', () => {
  const intel: IntelMemory = { schema: 1, rooms: {} };
  expect(isReachable(intel, 'W0N0', 100)).toBe(true);
  markUnreachable(intel, 'W0N0', 100);
  expect(isReachable(intel, 'W0N0', 100 + UNREACHABLE_TTL - 1)).toBe(false);
  expect(isReachable(intel, 'W0N0', 100 + UNREACHABLE_TTL)).toBe(true);
  expect(isReachable(intel, 'W0N2', 100)).toBe(true);
});

it('prunes expired unreachable records to keep intel bounded', () => {
  const intel: IntelMemory = { schema: 1, rooms: {}, unreachable: { W0N0: 10, W0N2: 5000 } };
  pruneUnreachable(intel, 10 + UNREACHABLE_TTL);
  expect(intel.unreachable?.W0N0).toBeUndefined();
  expect(intel.unreachable?.W0N2).toBe(5000);
});

it('bounds intel by evicting the oldest observations beyond the cap', () => {
  const rooms: Record<string, RoomIntel> = {};
  for (let i = 0; i < INTEL_CAP + 3; i++) rooms[`W${i}N0`] = intelAt(i * 10);
  pruneIntel(rooms);
  expect(Object.keys(rooms)).toHaveLength(INTEL_CAP);
  expect(rooms.W0N0).toBeUndefined();
  expect(rooms.W1N0).toBeUndefined();
  expect(rooms.W2N0).toBeUndefined();
  expect(rooms[`W${INTEL_CAP + 2}N0`]).toBeDefined();
});

it('maps a room snapshot into an intel record without losing threat detail', () => {
  const intel = observe({
    name: 'W0N2', now: 42,
    sources: [{ id: 's1', x: 5, y: 6 }, { id: 's2', x: 30, y: 31 }],
    controller: { level: 3, owner: 'enemy', reserver: 'enemy', reservationTicks: 1200 },
    hostiles: [{ armed: 4 }, { armed: 0 }],
    towers: 2, keeperLairs: 0, mineral: 'H',
  });
  expect(intel.observedAt).toBe(42);
  expect(intel.sources).toEqual([{ id: 's1', x: 5, y: 6 }, { id: 's2', x: 30, y: 31 }]);
  expect(intel.controller).toEqual({ level: 3, owner: 'enemy', reserver: 'enemy', reservationTicks: 1200 });
  expect(intel.threat).toEqual({ hostiles: 2, armed: 4, towers: 2, keeperLairs: 0 });
  expect(intel.mineral).toBe('H');
  const bare = observe({ name: 'W1N1', now: 7, sources: [], hostiles: [], towers: 0, keeperLairs: 3 });
  expect(bare.controller).toBeUndefined();
  expect(bare.mineral).toBeUndefined();
  expect(bare.threat.keeperLairs).toBe(3);
});
