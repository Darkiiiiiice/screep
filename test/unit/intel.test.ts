import { expect, it } from 'vitest';
import { intelState } from '../../src/game/intel';
import {
  INTEL_CAP,
  claimerSpawnNeed,
  pioneerSpawnNeed,
  evaluateRemoteTargets,
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

it('ranks fresh unowned source rooms by sources then distance, excluding untrusted or occupied rooms', () => {
  const room = (over: Partial<RoomIntel> = {}): RoomIntel => ({ observedAt: 1000, sources: [{ id: 's1', x: 1, y: 1 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, ...over });
  const twoSources = room({ sources: [{ id: 's1', x: 1, y: 1 }, { id: 's2', x: 2, y: 2 }] });
  const rooms: Record<string, RoomIntel> = {
    single: room(),
    dual: twoSources,
    far: twoSources,
    stale: room({ observedAt: 100 }),
    hostile: room({ threat: { hostiles: 1, armed: 2, towers: 0, keeperLairs: 0 } }),
    owned: room({ controller: { level: 3, owner: 'someone' } }),
    reserved: room({ controller: { level: 0, reserver: 'someone', reservationTicks: 100 } }),
    barren: room({ sources: [] }),
    unrouted: room(),
  };
  const targets = evaluateRemoteTargets({ rooms, distances: { single: 1, dual: 2, far: 5, stale: 1, hostile: 1, owned: 1, reserved: 1, barren: 1 }, me: 'me', now: 1200 });
  expect(targets.map(t => t.name)).toEqual(['dual', 'far', 'single']);
  expect(targets[0]).toMatchObject({ score: 180, sources: 2, distance: 2 });
});

it('keeps self-reserved rooms on the board for the DEPLOY step', () => {
  const rooms: Record<string, RoomIntel> = { mine: { observedAt: 1000, sources: [{ id: 's1', x: 1, y: 1 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0, reserver: 'me', reservationTicks: 4000 } } };
  expect(evaluateRemoteTargets({ rooms, distances: { mine: 1 }, me: 'me', now: 1200 }).map(t => t.name)).toEqual(['mine']);
  expect(evaluateRemoteTargets({ rooms, distances: { mine: 1 }, me: 'other', now: 1200 })).toEqual([]);
});

it('returns an empty board when no room qualifies', () => {
  const rooms: Record<string, RoomIntel> = { hostile: { observedAt: 1000, sources: [{ id: 's1', x: 1, y: 1 }], threat: { hostiles: 2, armed: 2, towers: 0, keeperLairs: 0 } } };
  expect(evaluateRemoteTargets({ rooms, distances: { hostile: 1 }, me: 'me', now: 1200 })).toEqual([]);
});

it('spawns a claimer only on full surplus against the top evaluated target needing reservation', () => {
  const intel = (over: Partial<IntelMemory> = {}): IntelMemory => ({
    schema: 1,
    rooms: { W0N2: { observedAt: 1000, sources: [{ id: 's1', x: 1, y: 1 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0 } } },
    evaluation: { tick: 1000, targets: [{ name: 'W0N2', score: 180, sources: 2, distance: 1 }] },
    ...over,
  });
  const base = { intel: intel(), workers: 6, capacity: 800, energyAvailable: 650, claimerAlive: false, me: 'me', now: 1200 };
  expect(claimerSpawnNeed(base)).toBe('W0N2');
  expect(claimerSpawnNeed({ ...base, capacity: 649 })).toBeNull();
  expect(claimerSpawnNeed({ ...base, energyAvailable: 649 })).toBeNull();
  expect(claimerSpawnNeed({ ...base, workers: 3 })).toBeNull();
  expect(claimerSpawnNeed({ ...base, claimerAlive: true })).toBeNull();
  const noEval = intel();
  delete noEval.evaluation;
  expect(claimerSpawnNeed({ ...base, intel: noEval })).toBeNull();
  expect(claimerSpawnNeed({ ...base, intel: intel({ lastClaimerDeathAt: 900 }) })).toBeNull();
  const reserved = intel();
  reserved.rooms.W0N2!.controller = { level: 0, reserver: 'me', reservationTicks: 4900 };
  expect(claimerSpawnNeed({ ...base, intel: reserved })).toBeNull();
  reserved.rooms.W0N2!.controller = { level: 0, reserver: 'me', reservationTicks: 1000 };
  expect(claimerSpawnNeed({ ...base, intel: reserved })).toBe('W0N2');
});

it('spawns a pioneer only against a self-reserved fresh top target on full surplus', () => {
  const intel = (over: Partial<IntelMemory> = {}): IntelMemory => ({
    schema: 1,
    rooms: { W0N2: { observedAt: 1000, sources: [{ id: 's1', x: 1, y: 1 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0, reserver: 'me', reservationTicks: 4000 } } },
    evaluation: { tick: 1000, targets: [{ name: 'W0N2', score: 180, sources: 2, distance: 1 }] },
    ...over,
  });
  const base = { intel: intel(), workers: 6, capacity: 800, energyAvailable: 650, pioneerAlive: false, me: 'me', now: 1200 };
  expect(pioneerSpawnNeed(base)).toBe('W0N2');
  expect(pioneerSpawnNeed({ ...base, capacity: 399 })).toBeNull();
  expect(pioneerSpawnNeed({ ...base, energyAvailable: 399 })).toBeNull();
  expect(pioneerSpawnNeed({ ...base, workers: 3 })).toBeNull();
  expect(pioneerSpawnNeed({ ...base, pioneerAlive: true })).toBeNull();
  expect(pioneerSpawnNeed({ ...base, intel: intel({ lastPioneerDeathAt: 1100 }) })).toBeNull();
  const unreserved = intel();
  unreserved.rooms.W0N2!.controller = { level: 0 };
  expect(pioneerSpawnNeed({ ...base, intel: unreserved })).toBeNull();
  const foreign = intel();
  foreign.rooms.W0N2!.controller = { level: 0, reserver: 'someone', reservationTicks: 4000 };
  expect(pioneerSpawnNeed({ ...base, intel: foreign })).toBeNull();
  const stale = intel();
  stale.rooms.W0N2!.observedAt = 100;
  expect(pioneerSpawnNeed({ ...base, intel: stale, now: 5000 })).toBeNull();
});
