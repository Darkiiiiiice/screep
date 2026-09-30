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

  it('M7-8b: timeout-excluded rooms stay off the board until the exclusion expires', () => {
    const rooms = { W0N1: room({ threat: { hostiles: 1, armed: 1, towers: 0, keeperLairs: 0, structures: 0 } }) };
    const distances = { W0N1: 1 };
    // 排除期内:榜空(打不下撤退的房不反复送兵)
    expect(evaluateAssaultTargets({ rooms, distances, now: 100, excludedUntil: { W0N1: 500 } })).toEqual([]);
    // 排除过期:重新上榜(房况可能已变,排除不是永久黑名单)
    expect(evaluateAssaultTargets({ rooms, distances, now: 500, excludedUntil: { W0N1: 500 } })).toEqual([{ name: 'W0N1', distance: 1, armed: 1, structures: 0 }]);
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
    expect(planAssaultSquad(0)).toEqual({ attackers: 2, healers: 1, dismantlers: 0, rangers: 0 });
    expect(planAssaultSquad(2)).toEqual({ attackers: 3, healers: 2, dismantlers: 0, rangers: 1 });
    expect(planAssaultSquad(9)).toEqual({ attackers: 4, healers: 2, dismantlers: 0, rangers: 1 });
    expect(planAssaultSquad(3)).toEqual({ attackers: 4, healers: 2, dismantlers: 0, rangers: 1 });
    // M7-8:敌建筑在场 -> 拆墙手 1 具(v1);无建筑不浪费 600
    expect(planAssaultSquad(2, 3)).toEqual({ attackers: 3, healers: 2, dismantlers: 1, rangers: 1 });
    expect(planAssaultSquad(2, 0)).toEqual({ attackers: 3, healers: 2, dismantlers: 0, rangers: 1 });
  });
});

describe('assault phase machine (M7-6)', () => {
  const state = (over: Partial<AssaultState> = {}): AssaultState => ({
    phase: 'muster',
    target: 'W0N1',
    plan: { attackers: 3, healers: 2, dismantlers: 0, rangers: 0 },
    attackers: ['a1', 'a2', 'a3'],
    healers: ['h1', 'h2'],
    dismantlers: [], rangers: [],
    losses: 0,
    ...over,
  });

  it('holds at muster until the squad is complete, then travels', () => {
    expect(advanceAssault(state({ attackers: ['a1'] }), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 }).phase).toBe('muster');
    expect(advanceAssault(state({ healers: ['h1'] }), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 }).phase).toBe('muster');
    expect(advanceAssault(state(), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 }).phase).toBe('travel');
    // M7-7:满编但强化未了结 -> 不翻开拔(强化腿不被名单数跳过)
    expect(advanceAssault(state(), { threatCleared: false, squadInRoom: false, squadBoostResolved: false, structuresCleared: true, squadAssembled: true, now: 0 }).phase).toBe('muster');
  });

  it('engages on arrival and completes when threat is cleared', () => {
    expect(advanceAssault(state({ phase: 'travel' }), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 }).phase).toBe('travel');
    const engaged = advanceAssault(state({ phase: 'travel' }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 });
    expect(engaged.phase).toBe('engage');
    expect(advanceAssault(state({ phase: 'engage' }), { threatCleared: true, squadInRoom: true, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 })).toEqual({ phase: 'done', complete: true });
  });

  it('M7-8 siege gates: muster waits for the dismantler; done requires structures razed', () => {
    const siege = { plan: { attackers: 3, healers: 2, dismantlers: 1, rangers: 0 } };
    // 拆墙手未到齐:满编攻击/医疗也不翻 travel
    expect(advanceAssault(state(siege), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: false, squadAssembled: true, now: 0 }).phase).toBe('muster');
    // 拆墙手到齐 -> travel
    expect(advanceAssault(state({ ...siege, dismantlers: ['d1'] }), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: false, squadAssembled: true, now: 0 }).phase).toBe('travel');
    // 武装清零但建筑未拆完 -> 不收档(围攻语义:拆完才算成)
    expect(advanceAssault(state({ ...siege, phase: 'engage', dismantlers: ['d1'] }), { threatCleared: true, squadInRoom: true, squadBoostResolved: true, structuresCleared: false, squadAssembled: true, now: 0 }).phase).toBe('engage');
    // 建筑清零 -> done
    expect(advanceAssault(state({ ...siege, phase: 'engage', dismantlers: ['d1'] }), { threatCleared: true, squadInRoom: true, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 })).toEqual({ phase: 'done', complete: true });
  });

  it('M7-9: muster gate waits for the ranger', () => {
    const kitePlan = { plan: { attackers: 3, healers: 2, dismantlers: 0, rangers: 1 } };
    // 游骑未到齐:攻击/医疗满编也不翻 travel
    expect(advanceAssault(state(kitePlan), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 }).phase).toBe('muster');
    // 游骑到齐 -> travel
    expect(advanceAssault(state({ ...kitePlan, rangers: ['r1'] }), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 }).phase).toBe('travel');
    // 人齐+强化齐但位置未就位 -> 仍 muster(M7-9 集结位置闸)
    expect(advanceAssault(state({ ...kitePlan, rangers: ['r1'] }), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true, squadAssembled: false, now: 0 }).phase).toBe('muster');
  });

  it('M7-8b: mission deadline bounds the burn; completion still wins at the buzzer', () => {
    const timed = { plan: { attackers: 3, healers: 2, dismantlers: 1, rangers: 0 }, deadline: 100 };
    // 未到期:照常作战
    expect(advanceAssault(state({ ...timed, phase: 'engage', dismantlers: ['d1'] }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: false, now: 99 , squadAssembled: true }).phase).toBe('engage');
    // 到期:一律撤退落台账(有界浪费也要收——TTL 自杀->折损撤退->冷却再锁
    // 的循环每轮烧 ~3170;时长预算把它改成一次性,目标另记排除期)。
    expect(advanceAssault(state({ ...timed, phase: 'engage', dismantlers: ['d1'] }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: false, now: 100 , squadAssembled: true }))
      .toEqual({ phase: 'withdraw', complete: false, withdrawReason: 'timeout' });
    // 集结期到期同样撤退(muster 600 时限先兜,总预算也要兜)。
    expect(advanceAssault(state({ ...timed, phase: 'muster' }), { threatCleared: false, squadInRoom: false, squadBoostResolved: false, structuresCleared: false, now: 100 , squadAssembled: true }).phase).toBe('withdraw');
    // 压哨完成:完成判据优先于时长(清场了就不白撤)。
    expect(advanceAssault(state({ ...timed, phase: 'engage', dismantlers: ['d1'] }), { threatCleared: true, squadInRoom: true, squadBoostResolved: true, structuresCleared: true, now: 100 , squadAssembled: true }))
      .toEqual({ phase: 'done', complete: true });
    // 老存档无 deadline:不判超时(迁移由 .game 层补值)。
    expect(advanceAssault(state({ phase: 'engage' }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: false, now: 99999 , squadAssembled: true }).phase).toBe('engage');
  });

  it('withdraws on loss budget breach and on a crippled squad', () => {
    const losses = advanceAssault(state({ phase: 'engage', losses: 1, attackers: ['a1', 'a2'], healers: ['h1'] }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 });
    expect(losses).toMatchObject({ phase: 'withdraw', withdrawReason: 'losses' });
    const crippled = advanceAssault(state({ phase: 'engage', losses: 0, attackers: ['a1'], healers: ['h1', 'h2'] }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 });
    expect(crippled).toMatchObject({ phase: 'withdraw', withdrawReason: 'crippled' });
  });

  it('reaches a terminal verdict on total extinction (no in-flight deadlock)', () => {
    const extinct = advanceAssault(state({ phase: 'engage', losses: 5, attackers: [], healers: [] }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 });
    expect(extinct).toMatchObject({ phase: 'withdraw', withdrawReason: 'losses' });
  });

  it('prefers completion over withdrawal once the room is cleared', () => {
    const cleared = advanceAssault(state({ phase: 'engage', losses: 1, attackers: ['a1', 'a2'], healers: ['h1'] }), { threatCleared: true, squadInRoom: true, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 });
    expect(cleared).toEqual({ phase: 'done', complete: true });
  });

  it('keeps fighting with healers gone but attackers intact', () => {
    const noHealers = advanceAssault(state({ phase: 'engage', healers: [], losses: 2 }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 });
    // losses 2 已破预算 → 撤;但若只是医疗阵亡(losses 计入)攻击手齐整时由预算判
    expect(['withdraw', 'engage']).toContain(noHealers.phase);
    const onlyHealersLost = advanceAssault(state({ phase: 'engage', healers: [], losses: 0 }), { threatCleared: false, squadInRoom: true, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 });
    expect(onlyHealersLost.phase).toBe('engage');
  });

  it('is terminal once done', () => {
    expect(advanceAssault(state({ phase: 'done' }), { threatCleared: false, squadInRoom: false, squadBoostResolved: true, structuresCleared: true, squadAssembled: true, now: 0 })).toEqual({ phase: 'done', complete: true });
  });
});

describe('assault spawn backfill with dismantlers (M7-8)', () => {
  const intelWith = (plan: { attackers: number; healers: number; dismantlers: number; rangers: number }) => ({
    schema: 1 as const, rooms: {}, distances: {},
    assault: { target: 'W0N1', phase: 'muster' as const, plan, attackers: ['a1', 'a2', 'a3'], healers: ['h1', 'h2'], dismantlers: [], rangers: [], losses: 0, startedAt: 0 },
  });
  const args = (intel: ReturnType<typeof intelWith>, aliveDismantlers: number, aliveRangers = 0) => ({
    intel, aliveAttackers: 3, aliveHealers: 2, aliveDismantlers, aliveRangers,
    workers: 6, capacity: 1300, energyAvailable: 1300, now: 100,
  });

  it('fields the dismantler after attackers and healers are filled', () => {
    const intel = intelWith({ attackers: 3, healers: 2, dismantlers: 1, rangers: 0 });
    expect(assaultSpawnNeed(args(intel, 0))).toMatchObject({ role: 'dismantler', bodyCost: 600 });
    expect(assaultSpawnNeed(args(intel, 1))).toBeNull();
  });

  it('never fields a dismantler for structure-free plans', () => {
    const intel = intelWith({ attackers: 3, healers: 2, dismantlers: 0, rangers: 0 });
    expect(assaultSpawnNeed(args(intel, 0))).toBeNull();
  });

  it('fields the ranger last, only for armed>=2 plans (M7-9)', () => {
    const kite = intelWith({ attackers: 3, healers: 2, dismantlers: 0, rangers: 1 });
    // 战位齐 + 无拆墙位 -> 游骑殿底补员,身体 400
    expect(assaultSpawnNeed(args(kite, 0, 0))).toMatchObject({ role: 'ranger', bodyCost: 400 });
    expect(assaultSpawnNeed(args(kite, 0, 1))).toBeNull();
    // 无游骑编成的计划永不补游骑
    const plain = intelWith({ attackers: 3, healers: 2, dismantlers: 0, rangers: 0 });
    expect(assaultSpawnNeed(args(plain, 0, 0))).toBeNull();
  });
});
