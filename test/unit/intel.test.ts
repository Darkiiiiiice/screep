import { expect, it } from 'vitest';
import { intelState } from '../../src/game/intel';
import {
  INTEL_CAP,
  claimerSpawnNeed,
  remoteHaulerSpawnNeed,
  remoteMinerSpawnNeed,
  colonizerSpawnNeed,
  pioneerSpawnNeed,
  resolveEvaluationRoot,
  evaluateColonizeTargets,
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
const intelAt = (observedAt: number, hostiles = 0, armed?: number): RoomIntel => ({
  observedAt,
  sources: [],
  threat: { hostiles, armed: armed ?? hostiles, towers: 0, keeperLairs: 0 },
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
  // 无武装过路斥候不是威胁(线上实证:hostiles 判据让 claimer 见路就自杀)。
  expect(threatActive(intelAt(100, 1, 0), 200)).toBe(false);
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

it('keeps rooms with unarmed passersby on the board', () => {
  const rooms: Record<string, RoomIntel> = { visited: { observedAt: 1000, sources: [{ id: 's1', x: 1, y: 1 }], threat: { hostiles: 2, armed: 0, towers: 0, keeperLairs: 0 } } };
  expect(evaluateRemoteTargets({ rooms, distances: { visited: 1 }, me: 'me', now: 1200 }).map(t => t.name)).toEqual(['visited']);
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


it('ranks only claimable rooms for colonization: unowned, no live foreign reservation', () => {
  const room = (over: Partial<RoomIntel> = {}): RoomIntel => ({ observedAt: 1000, sources: [{ id: 's1', x: 1, y: 1 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0 }, ...over });
  const twoSources = room({ sources: [{ id: 's1', x: 1, y: 1 }, { id: 's2', x: 2, y: 2 }] });
  const rooms: Record<string, RoomIntel> = {
    open: room(),
    dual: twoSources,
    owned: room({ controller: { level: 3, owner: 'someone' } }),
    mine: room({ controller: { level: 1, owner: 'me' } }),
    foreignReserved: room({ controller: { level: 0, reserver: 'someone', reservationTicks: 500 } }),
    selfReserved: room({ controller: { level: 0, reserver: 'me', reservationTicks: 4000 } }),
    hostile: room({ threat: { hostiles: 1, armed: 1, towers: 0, keeperLairs: 0 } }),
    noController: (() => { const r = room(); delete r.controller; return r; })(),
    unrouted: room(),
  };
  const distances = { open: 1, dual: 2, owned: 1, mine: 1, foreignReserved: 1, selfReserved: 1, hostile: 1, noController: 1 };
  const targets = evaluateColonizeTargets({ rooms, distances, me: 'me', now: 1200 });
  expect(targets.map(t => t.name)).toEqual(['dual', 'open', 'selfReserved']);
});

it('unlocks a colonize target when the foreign reservation has decayed past zero', () => {
  // 快照按观测年龄折算:新鲜观测读数 500、已自然衰减 300 → 有效 200 仍锁;
  // 读数降到 100 → 有效 -200 归零,房间回到可占榜
  // (与 claimer 门禁同一教训:信快照会睡死决策)。
  const rooms: Record<string, RoomIntel> = {
    contested: { observedAt: 900, sources: [{ id: 's1', x: 1, y: 1 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0, reserver: 'someone', reservationTicks: 500 } },
  };
  expect(evaluateColonizeTargets({ rooms, distances: { contested: 1 }, me: 'me', now: 1200 })).toEqual([]);
  rooms.contested!.controller!.reservationTicks = 100;
  expect(evaluateColonizeTargets({ rooms, distances: { contested: 1 }, me: 'me', now: 1200 }).map(t => t.name)).toEqual(['contested']);
});


it('spawns a colonizer only with a free GCL slot and full surplus against the top colonize target', () => {
  const intel = (over: Partial<IntelMemory> = {}): IntelMemory => ({
    schema: 1,
    rooms: { W0N2: { observedAt: 1000, sources: [{ id: 's1', x: 1, y: 1 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0 } } },
    colonization: { tick: 1000, targets: [{ name: 'W0N2', score: 90, sources: 1, distance: 1 }] },
    ...over,
  });
  const base = { intel: intel(), workers: 6, capacity: 800, energyAvailable: 650, colonizerAlive: false, gclFreeSlots: 1, now: 1200 };
  expect(colonizerSpawnNeed(base)).toBe('W0N2');
  // GCL 空额是硬闸:名额不足时不浪费派兵(验收原文;线上 GCL1 期间恒关)。
  expect(colonizerSpawnNeed({ ...base, gclFreeSlots: 0 })).toBeNull();
  expect(colonizerSpawnNeed({ ...base, capacity: 649 })).toBeNull();
  expect(colonizerSpawnNeed({ ...base, energyAvailable: 649 })).toBeNull();
  expect(colonizerSpawnNeed({ ...base, workers: 3 })).toBeNull();
  expect(colonizerSpawnNeed({ ...base, colonizerAlive: true })).toBeNull();
  // 死亡冷却 150(与预定者同源:须远小于 CLAIM 件寿命 600)。
  expect(colonizerSpawnNeed({ ...base, intel: intel({ lastColonizerDeathAt: 1100 }) })).toBeNull();
  expect(colonizerSpawnNeed({ ...base, intel: intel({ lastColonizerDeathAt: 1050 }) })).toBe('W0N2');
  // 无榜/目标情报过期不派兵(§3.6 失去视野≠安全)。
  const noBoard = intel();
  delete noBoard.colonization;
  expect(colonizerSpawnNeed({ ...base, intel: noBoard })).toBeNull();
  const staleTarget = intel();
  staleTarget.rooms.W0N2!.observedAt = 1200 - INTEL_STALE;
  expect(colonizerSpawnNeed({ ...base, intel: staleTarget })).toBeNull();
});
it('dispatches pioneers only to owned ungraduated colonies within squad cap', () => {
  const intel = (over: Partial<IntelMemory> = {}): IntelMemory => ({
    schema: 1,
    rooms: { W0N2: { observedAt: 1000, sources: [{ id: 's1', x: 1, y: 1 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 1, owner: 'me' } } },
    colonies: { W0N2: { claimedAt: 900 } },
    ...over,
  });
  const base = { intel: intel(), workers: 6, capacity: 800, energyAvailable: 800, pioneers: {} as Record<string, number>, me: 'me', now: 1200 };
  expect(pioneerSpawnNeed(base)).toBe('W0N2');
  // 盈余门与地板(§3.1 补员优先)。
  expect(pioneerSpawnNeed({ ...base, energyAvailable: 199 })).toBeNull();
  expect(pioneerSpawnNeed({ ...base, capacity: 199 })).toBeNull();
  expect(pioneerSpawnNeed({ ...base, workers: 3 })).toBeNull();
  // 台账缺席/已毕业/归属丢失/武装威胁/过期/不可达均不填人(§3.6)。
  const noColonies = intel();
  delete noColonies.colonies;
  expect(pioneerSpawnNeed({ ...base, intel: noColonies })).toBeNull();
  expect(pioneerSpawnNeed({ ...base, intel: intel({ colonies: { W0N2: { claimedAt: 900, spawnedAt: 1100 } } }) })).toBeNull();
  const lost = intel();
  lost.rooms.W0N2!.controller = { level: 1, owner: 'enemy' };
  expect(pioneerSpawnNeed({ ...base, intel: lost })).toBeNull();
  const armed = intel();
  armed.rooms.W0N2!.threat.armed = 2;
  expect(pioneerSpawnNeed({ ...base, intel: armed })).toBeNull();
  const stale = intel();
  stale.rooms.W0N2!.observedAt = 1200 - INTEL_STALE;
  expect(pioneerSpawnNeed({ ...base, intel: stale })).toBeNull();
  expect(pioneerSpawnNeed({ ...base, intel: intel({ unreachable: { W0N2: 1000 } }) })).toBeNull();
  // 满编停补;灭队冷却 300 内不再派(§1 失败有界),过后放行。
  expect(pioneerSpawnNeed({ ...base, pioneers: { W0N2: 3 } })).toBeNull();
  expect(pioneerSpawnNeed({ ...base, pioneers: { W0N2: 2 } })).toBe('W0N2');
  expect(pioneerSpawnNeed({ ...base, intel: intel({ colonies: { W0N2: { claimedAt: 900, lastPioneerWipeAt: 1100 } } }) })).toBeNull();
  expect(pioneerSpawnNeed({ ...base, intel: intel({ colonies: { W0N2: { claimedAt: 900, lastPioneerWipeAt: 890 } } }) })).toBe('W0N2');
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
  // 无缝交接:现任 TTL 低于提前量(400)时放行继任者(线上实证:预留真空期
  // pioneer 按规则自尽,且换班挤兑期 200 窗口攒不齐 650);TTL 健康时仍挡;
  // 未传 TTL 视为健康(上行已覆盖)。
  expect(claimerSpawnNeed({ ...base, claimerAlive: true, claimerTtl: 399 })).toBe('W0N2');
  expect(claimerSpawnNeed({ ...base, claimerAlive: true, claimerTtl: 400 })).toBeNull();
  const noEval = intel();
  delete noEval.evaluation;
  expect(claimerSpawnNeed({ ...base, intel: noEval })).toBeNull();
  // 死亡冷却 150(须远小于 CLAIM 件寿命 600,否则预定链覆盖率被冷却拖垮):
  // 100 tick 内仍拦截,150 已满即放行。
  expect(claimerSpawnNeed({ ...base, intel: intel({ lastClaimerDeathAt: 1100 }) })).toBeNull();
  expect(claimerSpawnNeed({ ...base, intel: intel({ lastClaimerDeathAt: 1050 }) })).toBe('W0N2');
  const reserved = intel();
  reserved.rooms.W0N2!.controller = { level: 0, reserver: 'me', reservationTicks: 4900 };
  expect(claimerSpawnNeed({ ...base, intel: reserved })).toBeNull();
  reserved.rooms.W0N2!.controller = { level: 0, reserver: 'me', reservationTicks: 1000 };
  // 快照须按观测年龄折算:读数 2100 高于刷新线,但观测已 400 tick 前,
  // 有效余量 1700 跌破刷新线 -> 应补孵(线上实证:信快照会把预定链睡死)。
  const staleRead = intel();
  staleRead.rooms.W0N2!.observedAt = 800;
  staleRead.rooms.W0N2!.controller = { level: 0, reserver: 'me', reservationTicks: 2100 };
  expect(claimerSpawnNeed({ ...base, intel: staleRead })).toBe('W0N2');
  expect(claimerSpawnNeed({ ...base, intel: reserved })).toBe('W0N2');
  // 外援预定自守(线上实证 2026-09-28:评估榜滞后期间 W36S2 被 darkiiiiiice
  // 预定,claimer 650/具按冷却节奏连续自烬):榜单目标被外人有效预定即拒;
  // 余量按情报年龄折算,衰减归零(预定已失效)即解锁放行。
  const foreign = intel();
  foreign.rooms.W0N2!.controller = { level: 0, reserver: 'rival', reservationTicks: 2053 };
  expect(claimerSpawnNeed({ ...base, intel: foreign })).toBeNull();
  const foreignLapsed = intel();
  foreignLapsed.rooms.W0N2!.observedAt = 200;
  foreignLapsed.rooms.W0N2!.controller = { level: 0, reserver: 'rival', reservationTicks: 900 };
  expect(claimerSpawnNeed({ ...base, intel: foreignLapsed })).toBe('W0N2');
});

it('spawns a remote miner only against a self-reserved fresh top target on full surplus', () => {
  const intel = (over: Partial<IntelMemory> = {}): IntelMemory => ({
    schema: 1,
    rooms: { W0N2: { observedAt: 1000, sources: [{ id: 's1', x: 1, y: 1 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0, reserver: 'me', reservationTicks: 4000 } } },
    evaluation: { tick: 1000, targets: [{ name: 'W0N2', score: 180, sources: 2, distance: 1 }] },
    ...over,
  });
  const base = { intel: intel(), workers: 6, capacity: 800, energyAvailable: 650, minerAlive: false, me: 'me', now: 1200 };
  expect(remoteMinerSpawnNeed(base)).toBe('W0N2');
  expect(remoteMinerSpawnNeed({ ...base, capacity: 549 })).toBeNull();
  expect(remoteMinerSpawnNeed({ ...base, energyAvailable: 549 })).toBeNull();
  expect(remoteMinerSpawnNeed({ ...base, workers: 3 })).toBeNull();
  expect(remoteMinerSpawnNeed({ ...base, minerAlive: true })).toBeNull();
  expect(remoteMinerSpawnNeed({ ...base, intel: intel({ lastRemoteMinerDeathAt: 1100 }) })).toBeNull();
  const unreserved = intel();
  unreserved.rooms.W0N2!.controller = { level: 0 };
  expect(remoteMinerSpawnNeed({ ...base, intel: unreserved })).toBeNull();
  const foreign = intel();
  foreign.rooms.W0N2!.controller = { level: 0, reserver: 'someone', reservationTicks: 4000 };
  expect(remoteMinerSpawnNeed({ ...base, intel: foreign })).toBeNull();
  const stale = intel();
  stale.rooms.W0N2!.observedAt = 100;
  expect(remoteMinerSpawnNeed({ ...base, intel: stale, now: 5000 })).toBeNull();
});

it('fields haulers only while a miner is on station, capped per miner', () => {
  const intel = (over: Partial<IntelMemory> = {}): IntelMemory => ({
    schema: 1,
    rooms: { W0N2: { observedAt: 1000, sources: [{ id: 's1', x: 1, y: 1 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0, reserver: 'me', reservationTicks: 4000 } } },
    evaluation: { tick: 1000, targets: [{ name: 'W0N2', score: 180, sources: 2, distance: 1 }] },
    ...over,
  });
  // 无产不运:矿工不在岗,搬运工不许出门。
  const base = { intel: intel(), workers: 6, capacity: 800, energyAvailable: 650, haulers: 0, miners: 1, me: 'me', now: 1200 };
  expect(remoteHaulerSpawnNeed(base)).toBe('W0N2');
  expect(remoteHaulerSpawnNeed({ ...base, miners: 0 })).toBeNull();
  expect(remoteHaulerSpawnNeed({ ...base, haulers: 3 })).toBeNull();
  expect(remoteHaulerSpawnNeed({ ...base, haulers: 1, miners: 1 })).toBe('W0N2');
  expect(remoteHaulerSpawnNeed({ ...base, capacity: 399 })).toBeNull();
  expect(remoteHaulerSpawnNeed({ ...base, energyAvailable: 399 })).toBeNull();
  expect(remoteHaulerSpawnNeed({ ...base, workers: 3 })).toBeNull();
  expect(remoteHaulerSpawnNeed({ ...base, intel: intel({ lastRemoteHaulerDeathAt: 1100 }) })).toBeNull();
  const unreserved = intel();
  unreserved.rooms.W0N2!.controller = { level: 0 };
  expect(remoteHaulerSpawnNeed({ ...base, intel: unreserved })).toBeNull();
});

it('pins the evaluation root and re-anchors with a distance-cache wipe on root loss', () => {
  // 首评锚定调用方,不清缓存(尚无缓存可清)。
  expect(resolveEvaluationRoot(undefined, 'W0N1', false)).toEqual({ root: 'W0N1', clear: false });
  // 根房在我手:维持原根——殖民房调用不得改锚(距离缓存全是根相对的)。
  expect(resolveEvaluationRoot('W0N1', 'W0N2', true)).toEqual({ root: 'W0N1', clear: false });
  // 根房失守:重锚到调用方并清缓存;无根失守(首评外不可能)语义同上。
  expect(resolveEvaluationRoot('W0N1', 'W0N2', false)).toEqual({ root: 'W0N2', clear: true });
});
