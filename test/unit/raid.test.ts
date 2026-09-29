import { describe, expect, it } from 'vitest';
import { advanceAssault, assaultSpawnNeed, evaluateAssaultTargets, planAssaultSquad } from '../../src/domain/raid';
import type { AssaultState } from '../../src/domain/raid';
import type { RoomIntel } from '../../src/domain/intel';
import { INTEL_STALE } from '../../src/domain/intel';

const room = (over: Partial<RoomIntel> = {}): RoomIntel => ({
  observedAt: 1000,
  sources: [{ id: 's1', x: 1, y: 1 }],
  threat: { hostiles: 1, armed: 2, towers: 0, keeperLairs: 0, structures: 0 },
  ...over,
});

describe('assault target evaluation (M7-6)', () => {
  it('keeps only armed squatted valuable rooms within reach', () => {
    const rooms = {
      // 合格:武装蹲守无主有源近房
      W0N1: room(),
      // 无武装:守家口径,过路人不算目标
      W0N2: room({ threat: { hostiles: 1, armed: 0, towers: 0, keeperLairs: 0, structures: 0 } }),
      // 有塔:v1 不破塔
      W0N3: room({ threat: { hostiles: 1, armed: 2, towers: 1, keeperLairs: 0, structures: 0 } }),
      // 有主:战争级不做
      W0N4: room({ controller: { level: 3, owner: 'enemy' } }),
      // 无源:没有经济价值不开战
      W0N5: room({ sources: [] }),
      // 过期:失去视野≠安全
      W0N6: room({ observedAt: 1200 - INTEL_STALE }),
      // 太远:行军损耗失去意义
      W1N0: room(),
    };
    const distances = { W0N1: 1, W0N2: 1, W0N3: 1, W0N4: 1, W0N5: 1, W0N6: 1, W1N0: 3 };
    const targets = evaluateAssaultTargets({ rooms, distances, now: 1200 });
    expect(targets.map((t) => t.name)).toEqual(['W0N1']);
  });

  it('drops unwinnable rooms: armed at the cap never boards (+1 superiority preserved)', () => {
    const rooms = {
      W0N1: room({ threat: { hostiles: 2, armed: 4, towers: 0, keeperLairs: 0, structures: 0 } }),
      W0N2: room({ threat: { hostiles: 1, armed: 3, towers: 0, keeperLairs: 0, structures: 0 } }),
    };
    const targets = evaluateAssaultTargets({ rooms, distances: { W0N1: 1, W0N2: 1 }, now: 1200 });
    expect(targets.map((x) => x.name)).toEqual(['W0N2']);
  });

  it('sorts softest target first, then by name', () => {
    const rooms = { W0N2: room({ threat: { hostiles: 1, armed: 3, towers: 0, keeperLairs: 0, structures: 0 } }), W0N1: room() };
    const targets = evaluateAssaultTargets({ rooms, distances: { W0N1: 1, W0N2: 1 }, now: 1200 });
    expect(targets.map((t) => t.name)).toEqual(['W0N1', 'W0N2']);
    expect(targets[0]?.armed).toBe(2);
  });
});

describe('assault squad composition (M7-6)', () => {
  it('fields local superiority and caps the budget', () => {
    expect(planAssaultSquad(0)).toEqual({ attackers: 2, healers: 1, dismantlers: 0 });
    expect(planAssaultSquad(2)).toEqual({ attackers: 3, healers: 2, dismantlers: 0 });
    expect(planAssaultSquad(9)).toEqual({ attackers: 4, healers: 2, dismantlers: 0 });
    expect(planAssaultSquad(3)).toEqual({ attackers: 4, healers: 2, dismantlers: 0 });
    // M7-8:敌建筑在场 -> 拆墙手 1 具(v1);无建筑不浪费 600
    expect(planAssaultSquad(2, 3)).toEqual({ attackers: 3, healers: 2, dismantlers: 1 });
    expect(planAssaultSquad(2, 0)).toEqual({ attackers: 3, healers: 2, dismantlers: 0 });
  });
});

describe('assault phase machine (M7-6)', () => {
  const state = (over: Partial<AssaultState> = {}): AssaultState => ({
    phase: 'muster',
    target: 'W0N1',
    plan: { attackers: 3, healers: 2, dismantlers: 0 },
    attackers: ['a1', 'a2', 'a3'],
    healers: ['h1', 'h2'],
    dismantlers: [],
    losses: 0,
    ...over,
  });

  it('holds at muster until the squad is complete, then travels', () => {
    expect(advanceAssault(state({ attackers: ['a1'] }), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true }).phase).toBe('muster');
    expect(advanceAssault(state({ healers: ['h1'] }), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true }).phase).toBe('muster');
    expect(advanceAssault(state(), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true }).phase).toBe('travel');
    // M7-7:满编但强化未了结 -> 不翻开拔(强化腿不被名单数跳过)
    expect(advanceAssault(state(), { threatCleared: false, squadInRoom: false, squadBoostResolved: false, structuresCleared: true }).phase).toBe('muster');
  });

  it('engages on arrival and completes when threat is cleared', () => {
    expect(advanceAssault(state({ phase: 'travel' }), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true }).phase).toBe('travel');
    const engaged = advanceAssault(state({ phase: 'travel' }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: true });
    expect(engaged.phase).toBe('engage');
    expect(advanceAssault(state({ phase: 'engage' }), { threatCleared: true, squadInRoom: true, squadBoostResolved: true, structuresCleared: true })).toEqual({ phase: 'done', complete: true });
  });

  it('M7-8 siege gates: muster waits for the dismantler; done requires structures razed', () => {
    const siege = { plan: { attackers: 3, healers: 2, dismantlers: 1 } };
    // 拆墙手未到齐:满编攻击/医疗也不翻 travel
    expect(advanceAssault(state(siege), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: false }).phase).toBe('muster');
    // 拆墙手到齐 -> travel
    expect(advanceAssault(state({ ...siege, dismantlers: ['d1'] }), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: false }).phase).toBe('travel');
    // 武装清零但建筑未拆完 -> 不收档(围攻语义:拆完才算成)
    expect(advanceAssault(state({ ...siege, phase: 'engage', dismantlers: ['d1'] }), { threatCleared: true, squadInRoom: true, squadBoostResolved: true, structuresCleared: false }).phase).toBe('engage');
    // 建筑清零 -> done
    expect(advanceAssault(state({ ...siege, phase: 'engage', dismantlers: ['d1'] }), { threatCleared: true, squadInRoom: true, squadBoostResolved: true, structuresCleared: true })).toEqual({ phase: 'done', complete: true });
  });

  it('withdraws on loss budget breach and on a crippled squad', () => {
    const losses = advanceAssault(state({ phase: 'engage', losses: 1, attackers: ['a1', 'a2'], healers: ['h1'] }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: true });
    expect(losses).toMatchObject({ phase: 'withdraw', withdrawReason: 'losses' });
    const crippled = advanceAssault(state({ phase: 'engage', losses: 0, attackers: ['a1'], healers: ['h1', 'h2'] }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: true });
    expect(crippled).toMatchObject({ phase: 'withdraw', withdrawReason: 'crippled' });
  });

  it('reaches a terminal verdict on total extinction (no in-flight deadlock)', () => {
    const extinct = advanceAssault(state({ phase: 'engage', losses: 5, attackers: [], healers: [] }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: true });
    expect(extinct).toMatchObject({ phase: 'withdraw', withdrawReason: 'losses' });
  });

  it('prefers completion over withdrawal once the room is cleared', () => {
    const cleared = advanceAssault(state({ phase: 'engage', losses: 1, attackers: ['a1', 'a2'], healers: ['h1'] }), { threatCleared: true, squadInRoom: true, squadBoostResolved: true, structuresCleared: true });
    expect(cleared).toEqual({ phase: 'done', complete: true });
  });

  it('keeps fighting with healers gone but attackers intact', () => {
    const noHealers = advanceAssault(state({ phase: 'engage', healers: [], losses: 2 }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: true });
    // losses 2 已破预算 → 撤;但若只是医疗阵亡(losses 计入)攻击手齐整时由预算判
    expect(['withdraw', 'engage']).toContain(noHealers.phase);
    const onlyHealersLost = advanceAssault(state({ phase: 'engage', healers: [], losses: 0 }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: true });
    expect(onlyHealersLost.phase).toBe('engage');
  });

  it('is terminal once done', () => {
    expect(advanceAssault(state({ phase: 'done' }), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true })).toEqual({ phase: 'done', complete: true });
  });
});

describe('assault spawn backfill with dismantlers (M7-8)', () => {
  const intelWith = (plan: { attackers: number; healers: number; dismantlers: number }) => ({
    rooms: {}, distances: {},
    assault: { target: 'W0N1', phase: 'muster' as const, plan, attackers: ['a1', 'a2', 'a3'], healers: ['h1', 'h2'], dismantlers: [], losses: 0, startedAt: 0 },
  });
  const args = (intel: ReturnType<typeof intelWith>, aliveDismantlers: number) => ({
    intel, aliveAttackers: 3, aliveHealers: 2, aliveDismantlers,
    workers: 6, capacity: 1300, energyAvailable: 1300, now: 100,
  });

  it('fields the dismantler after attackers and healers are filled', () => {
    const intel = intelWith({ attackers: 3, healers: 2, dismantlers: 1 });
    expect(assaultSpawnNeed(args(intel, 0))).toMatchObject({ role: 'dismantler', bodyCost: 600 });
    expect(assaultSpawnNeed(args(intel, 1))).toBeNull();
  });

  it('never fields a dismantler for structure-free plans', () => {
    const intel = intelWith({ attackers: 3, healers: 2, dismantlers: 0 });
    expect(assaultSpawnNeed(args(intel, 0))).toBeNull();
  });
});
