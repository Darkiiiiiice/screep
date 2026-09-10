import { describe, expect, it } from 'vitest';
import { bodyCost, countPart, designBody, designForRole, ROLE_RATIO } from '@/domain/body';
import type { Body, BodyPart } from '@/domain/types';

describe('designBody', () => {
  it('buys a whole number of blocks and spends the remainder on single parts', () => {
    // One {work,carry,move} block is 200. With 300 the colony gets a block plus
    // 100 left, which is exactly one more WORK — the most valuable part for a
    // harvester, since WORK is what sets harvest rate.
    const body = designBody(300, { work: 1, carry: 1, move: 1 });
    expect(body).not.toBeNull();
    expect(bodyCost(body as Body)).toBe(300);
    expect(countPart(body as Body, 'work')).toBe(2);
  });

  it('never exceeds the budget', () => {
    for (const budget of [200, 250, 300, 550, 750, 1300, 5000]) {
      const body = designBody(budget, { work: 2, carry: 1, move: 1 });
      expect(body, `budget ${String(budget)}`).not.toBeNull();
      expect(bodyCost(body as Body), `budget ${String(budget)}`).toBeLessThanOrEqual(budget);
    }
  });

  it('builds the best creep affordable instead of waiting for the ideal one', () => {
    // The requested shape costs 300, but 200 buys a working {work,carry,move}.
    // Returning null would leave 200 energy sitting in the spawn producing
    // nothing; a slower harvester is strictly better than no harvester.
    const body = designBody(200, { work: 2, carry: 1, move: 1 });
    expect(body).not.toBeNull();
    expect(bodyCost(body as Body)).toBe(200);
    expect(countPart(body as Body, 'work')).toBe(1);
    expect(countPart(body as Body, 'move')).toBe(1);
  });

  it('uses the full requested shape when the budget allows it', () => {
    // Downscaling must only happen when forced, never as a shortcut.
    const body = designBody(300, { work: 2, carry: 1, move: 1 });
    expect(body).not.toBeNull();
    expect(countPart(body as Body, 'work')).toBe(2);
    expect(bodyCost(body as Body)).toBe(300);
  });

  it('returns null rather than a crippled body when even one part each is unaffordable', () => {
    // 100 energy cannot buy {work,carry,move}=200. A WORK-only creep could mine
    // but never move or carry, which is worse than waiting.
    expect(designBody(100, { work: 1, carry: 1, move: 1 })).toBeNull();
    expect(designBody(0, { work: 1, carry: 1, move: 1 })).toBeNull();
  });

  it('caps at the engine limit of 50 parts', () => {
    // Spawn capacity caps real budgets long before this, but the function must
    // not be able to produce an invalid body if it is called with a huge number.
    const body = designBody(1_000_000, { work: 1, carry: 1, move: 1 });
    expect(body).not.toBeNull();
    expect((body as Body).length).toBeLessThanOrEqual(50);
  });

  it('refuses a ratio with no MOVE part', () => {
    // A body without MOVE is a permanently stuck creep. Failing loudly here is
    // better than producing one that looks fine in the spawn queue.
    expect(() => designBody(300, { work: 1, carry: 1 })).toThrow(/MOVE/);
  });

  it('refuses a ratio containing unknown parts', () => {
    // Cast because the union rejects an unknown part at compile time — which is
    // the stronger guarantee; this test covers a caller that bypassed types.
    const bogus = { work: 1, move: 1, laser: 1 } as unknown as Partial<Record<BodyPart, number>>;
    expect(() => designBody(300, bogus)).toThrow(/unknown/);
  });

  it('scales the shape up as the budget grows', () => {
    const small = designBody(300, { work: 1, carry: 1, move: 1 }) as Body;
    const large = designBody(1200, { work: 1, carry: 1, move: 1 }) as Body;
    expect(large.length).toBeGreaterThan(small.length);
    expect(bodyCost(large)).toBeLessThanOrEqual(1200);
  });
});

describe('role bodies', () => {
  it('gives every role a body with MOVE, so none is immobile', () => {
    for (const role of Object.keys(ROLE_RATIO)) {
      const body = designForRole(role, 300);
      expect(body, role).not.toBeNull();
      expect(countPart(body as Body, 'move'), role).toBeGreaterThan(0);
    }
  });

  it('gives harvesting roles WORK parts and pure carriers none', () => {
    // A hauler that spent energy on WORK would be paying for a part it never
    // uses; that is a wasted 100 energy per part on every hauler forever.
    const harvester = designForRole('harvester', 600) as Body;
    const hauler = designForRole('hauler', 600) as Body;
    expect(countPart(harvester, 'work')).toBeGreaterThan(0);
    expect(countPart(hauler, 'work')).toBe(0);
    expect(countPart(hauler, 'carry')).toBeGreaterThan(0);
  });

  it('returns null for an unknown role instead of guessing', () => {
    expect(designForRole('wizard', 1000)).toBeNull();
  });
});

describe('bodyCost', () => {
  it('matches the engine part costs', () => {
    expect(bodyCost(['work'])).toBe(100);
    expect(bodyCost(['carry'])).toBe(50);
    expect(bodyCost(['move'])).toBe(50);
    expect(bodyCost(['work', 'carry', 'move'])).toBe(200);
  });
});
