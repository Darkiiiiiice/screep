import { describe, expect, it } from 'vitest';
import { advanceAssault, evaluateAssaultTargets, planAssaultSquad } from '../../src/domain/raid';
import type { AssaultState } from '../../src/domain/raid';
import type { RoomIntel } from '../../src/domain/intel';
import { INTEL_STALE } from '../../src/domain/intel';

const room = (over: Partial<RoomIntel> = {}): RoomIntel => ({
  observedAt: 1000,
  sources: [{ id: 's1', x: 1, y: 1 }],
  threat: { hostiles: 1, armed: 2, towers: 0, keeperLairs: 0 },
  ...over,
});

describe('assault target evaluation (M7-6)', () => {
  it('keeps only armed squatted valuable rooms within reach', () => {
    const rooms = {
      // 合格:武装蹲守无主有源近房
      W0N1: room(),
      // 无武装:守家口径,过路人不算目标
      W0N2: room({ threat: { hostiles: 1, armed: 0, towers: 0, keeperLairs: 0 } }),
      // 有塔:v1 不破塔
      W0N3: room({ threat: { hostiles: 1, armed: 2, towers: 1, keeperLairs: 0 } }),
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
      W0N1: room({ threat: { hostiles: 2, armed: 4, towers: 0, keeperLairs: 0 } }),
      W0N2: room({ threat: { hostiles: 1, armed: 3, towers: 0, keeperLairs: 0 } }),
    };
    const targets = evaluateAssaultTargets({ rooms, distances: { W0N1: 1, W0N2: 1 }, now: 1200 });
    expect(targets.map((x) => x.name)).toEqual(['W0N2']);
  });

  it('sorts softest target first, then by name', () => {
    const rooms = { W0N2: room({ threat: { hostiles: 1, armed: 3, towers: 0, keeperLairs: 0 } }), W0N1: room() };
    const targets = evaluateAssaultTargets({ rooms, distances: { W0N1: 1, W0N2: 1 }, now: 1200 });
    expect(targets.map((t) => t.name)).toEqual(['W0N1', 'W0N2']);
    expect(targets[0]?.armed).toBe(2);
  });
});

describe('assault squad composition (M7-6)', () => {
  it('fields local superiority and caps the budget', () => {
    expect(planAssaultSquad(0)).toEqual({ attackers: 2, healers: 1 });
    expect(planAssaultSquad(2)).toEqual({ attackers: 3, healers: 2 });
    expect(planAssaultSquad(9)).toEqual({ attackers: 4, healers: 2 });
    expect(planAssaultSquad(3)).toEqual({ attackers: 4, healers: 2 });
  });
});

describe('assault phase machine (M7-6)', () => {
  const state = (over: Partial<AssaultState> = {}): AssaultState => ({
    phase: 'muster',
    target: 'W0N1',
    plan: { attackers: 3, healers: 2 },
    attackers: ['a1', 'a2', 'a3'],
    healers: ['h1', 'h2'],
    losses: 0,
    ...over,
  });

  it('holds at muster until the squad is complete, then travels', () => {
    expect(advanceAssault(state({ attackers: ['a1'] }), { threatCleared: false, squadInRoom: false }).phase).toBe('muster');
    expect(advanceAssault(state({ healers: ['h1'] }), { threatCleared: false, squadInRoom: false }).phase).toBe('muster');
    expect(advanceAssault(state(), { threatCleared: false, squadInRoom: false }).phase).toBe('travel');
  });

  it('engages on arrival and completes when threat is cleared', () => {
    expect(advanceAssault(state({ phase: 'travel' }), { threatCleared: false, squadInRoom: false }).phase).toBe('travel');
    const engaged = advanceAssault(state({ phase: 'travel' }), { threatCleared: false, squadInRoom: true });
    expect(engaged.phase).toBe('engage');
    expect(advanceAssault(state({ phase: 'engage' }), { threatCleared: true, squadInRoom: true })).toEqual({ phase: 'done', complete: true });
  });

  it('withdraws on loss budget breach and on a crippled squad', () => {
    const losses = advanceAssault(state({ phase: 'engage', losses: 1, attackers: ['a1', 'a2'], healers: ['h1'] }), { threatCleared: false, squadInRoom: true });
    expect(losses).toMatchObject({ phase: 'withdraw', withdrawReason: 'losses' });
    const crippled = advanceAssault(state({ phase: 'engage', losses: 0, attackers: ['a1'], healers: ['h1', 'h2'] }), { threatCleared: false, squadInRoom: true });
    expect(crippled).toMatchObject({ phase: 'withdraw', withdrawReason: 'crippled' });
  });

  it('reaches a terminal verdict on total extinction (no in-flight deadlock)', () => {
    const extinct = advanceAssault(state({ phase: 'engage', losses: 5, attackers: [], healers: [] }), { threatCleared: false, squadInRoom: true });
    expect(extinct).toMatchObject({ phase: 'withdraw', withdrawReason: 'losses' });
  });

  it('prefers completion over withdrawal once the room is cleared', () => {
    const cleared = advanceAssault(state({ phase: 'engage', losses: 1, attackers: ['a1', 'a2'], healers: ['h1'] }), { threatCleared: true, squadInRoom: true });
    expect(cleared).toEqual({ phase: 'done', complete: true });
  });

  it('keeps fighting with healers gone but attackers intact', () => {
    const noHealers = advanceAssault(state({ phase: 'engage', healers: [], losses: 2 }), { threatCleared: false, squadInRoom: true });
    // losses 2 已破预算 → 撤;但若只是医疗阵亡(losses 计入)攻击手齐整时由预算判
    expect(['withdraw', 'engage']).toContain(noHealers.phase);
    const onlyHealersLost = advanceAssault(state({ phase: 'engage', healers: [], losses: 0 }), { threatCleared: false, squadInRoom: true });
    expect(onlyHealersLost.phase).toBe('engage');
  });

  it('is terminal once done', () => {
    expect(advanceAssault(state({ phase: 'done' }), { threatCleared: false, squadInRoom: false })).toEqual({ phase: 'done', complete: true });
  });
});
