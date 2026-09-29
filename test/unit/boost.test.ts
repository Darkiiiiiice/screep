import { describe, expect, it } from 'vitest';
import { BOOST_MINERAL_PER_PART, chooseRecipeWithDemand, combatBoostDemand, squadBoostLeg, stockWithLabHoldings } from '../../src/domain/boost';

describe('squad boost leg (M7-7)', () => {
  const assaulter = (boosts: Array<string | undefined> = [undefined, undefined, undefined]) => ({
    memory: { role: 'assaulter' },
    body: [
      { type: 'attack', boost: boosts[0] },
      { type: 'attack', boost: boosts[1] },
      { type: 'attack', boost: boosts[2] },
      { type: 'move' }, { type: 'move' }, { type: 'move' },
    ],
  });

  it('counts only unboosted parts the role compound can boost', () => {
    expect(squadBoostLeg(assaulter())).toEqual({ compound: 'UH', parts: 3 });
    // MOVE 不在 UH 可强化表内:不算进需求(引擎 boostCreep 同口径)
    expect(squadBoostLeg({ memory: { role: 'assaulter' }, body: [{ type: 'move' }] })).toBeNull();
  });

  it('returns null once fully boosted', () => {
    expect(squadBoostLeg(assaulter(['UH', 'UH', 'UH']))).toBeNull();
    expect(squadBoostLeg(assaulter(['UH', 'UH', undefined]))).toEqual({ compound: 'UH', parts: 1 });
  });

  it('roles without a compound march straight to muster', () => {
    expect(squadBoostLeg({ memory: { role: 'medic' }, body: [{ type: 'heal' }] })).toBeNull();
    expect(squadBoostLeg({ memory: {}, body: [{ type: 'attack' }] })).toBeNull();
  });
});

describe('combat boost demand (M7-7)', () => {
  it('derives compound stock targets from the squad plan', () => {
    // 3 攻击手 × 3 attack × 30;医疗 v1 无化合物不进账
    expect(combatBoostDemand({ attackers: 3, healers: 2 })).toEqual({ UH: 9 * BOOST_MINERAL_PER_PART });
    expect(combatBoostDemand({ attackers: 4, healers: 2 })).toEqual({ UH: 12 * BOOST_MINERAL_PER_PART });
  });

  it('empty plan yields empty demand', () => {
    expect(combatBoostDemand({ attackers: 0, healers: 0 })).toEqual({});
  });
});

describe('recipe priority with demand (M7-7)', () => {
  it('prefers the demanded combat compound while unmet', () => {
    expect(chooseRecipeWithDemand({ stock: { U: 500, H: 500, L: 500 }, demand: { UH: 270 } })?.out).toBe('UH');
  });

  it('falls through to the generic table once demand is met', () => {
    // UH 已达需求且 U 见底:UH 炉开不了,回落通用表按表序选 LH(LH 在 LO 前)
    expect(chooseRecipeWithDemand({ stock: { UH: 300, H: 500, L: 500 }, demand: { UH: 270 } })?.out).toBe('LH');
  });

  it('cannot start the demanded line without input floor', () => {
    expect(chooseRecipeWithDemand({ stock: { U: 30, H: 500 }, demand: { UH: 270 } })).toBeUndefined();
  });

  it('no demand keeps the M6-5 behavior', () => {
    expect(chooseRecipeWithDemand({ stock: { H: 500, O: 500 } })?.out).toBe('OH');
  });
});
describe('stockWithLabHoldings (M7-7 评审加固)', () => {
  it('lab 持仓并入需求判据:强化料产在输出 lab,terminal 空仓也能落闸', () => {
    // terminal 0 UH + 输出 lab 270 UH = 达 3 突击手需求;未合并时 terminal
    // 恒 0 < 270,落闸永不生效(评审实证:muster 期恒产到输入见底)。
    const merged = stockWithLabHoldings({ UH: 0, H: 500 }, [{ UH: 270 }, { H: 100 }], ['UH']);
    expect(merged.UH).toBe(270);
    expect(merged.UH).toBeGreaterThanOrEqual(270);
  });

  it('只合并需求化合物:输入矿持仓不进账,原 stock 不被改写', () => {
    const stock = { UH: 10, H: 500 };
    const merged = stockWithLabHoldings(stock, [{ UH: 5, U: 300 }], ['UH']);
    expect(merged).toEqual({ UH: 15, H: 500 });
    expect(stock).toEqual({ UH: 10, H: 500 });
  });
});
