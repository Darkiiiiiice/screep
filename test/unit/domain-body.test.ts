import { describe, expect, it } from 'vitest';
import { bodyCost, countPart, designBody, designForRole, ROLE_RATIO } from '@/domain/body';
import type { Body, BodyPart } from '@/domain/types';

/**
 * Smallest body whose MOVE keeps pace with its other parts.
 *
 * Mirrors the engine's fatigue rule (each MOVE cancels 2, each other part adds
 * 2) so the tests can compute the affordability threshold rather than hardcode
 * it.
 */
function expandBalanced(ratio: Partial<Record<BodyPart, number>>): Body {
  const body: Body = [];
  let nonMove = 0;
  for (const part of Object.keys(ratio) as BodyPart[]) {
    if (part === 'move') continue;
    for (let i = 0; i < (ratio[part] ?? 0); i += 1) {
      body.push(part);
      nonMove += 1;
    }
  }
  const move = Math.max(ratio.move ?? 0, nonMove);
  for (let i = 0; i < move; i += 1) body.push('move');
  return body;
}

describe('designBody', () => {
  it('buys whole blocks only, preserving the requested shape', () => {
    // A {work, carry, move:2} block is 250. With 300 there is room for one block
    // and 50 change — not enough for a second, so the change is left unspent.
    // Spending it on a loose part would break the shape, and the shape IS the
    // movement balance.
    const one = designBody(300, { work: 1, carry: 1, move: 2 });
    expect(bodyCost(one as Body)).toBe(250);

    const two = designBody(500, { work: 1, carry: 1, move: 2 });
    expect(bodyCost(two as Body)).toBe(500);
    expect(countPart(two as Body, 'work')).toBe(2);
  });

  it('corrects a ratio that could not move at full speed', () => {
    // {1 work, 1 carry, 1 move} has 2 non-MOVE parts and 1 MOVE, so it would
    // crawl at 2 ticks/tile. The designer raises MOVE to match rather than
    // building a body it knows will be slow.
    const body = designBody(300, { work: 1, carry: 1, move: 1 });
    expect(body).not.toBeNull();

    const nonMove = (body as Body).filter((p) => p !== 'move').length;
    expect(countPart(body as Body, 'move')).toBeGreaterThanOrEqual(nonMove);
    expect(bodyCost(body as Body)).toBe(250);
  });

  it('keeps MOVE at parity with the other parts whenever the budget allows', () => {
    // The bug this pins: buying the remainder part-by-part produced bodies like
    // 4 carry + 2 move. A creep moves one tile per tick only while
    // MOVE >= non-MOVE (each MOVE cancels 2 fatigue, each other part adds 2), so
    // that body moved at 3 ticks/tile — measured live as an upgrader spending
    // half its life walking.
    const ratios = [
      { work: 1, carry: 1, move: 2 },
      { carry: 1, move: 1 },
      { attack: 1, move: 1 },
    ];

    for (const ratio of ratios) {
      const minimal = bodyCost(expandBalanced(ratio));
      for (const budget of [minimal, 400, 550, 1000, 2400]) {
        const body = designBody(budget, ratio);
        expect(body, `${JSON.stringify(ratio)} @ ${String(budget)}`).not.toBeNull();

        const nonMove = (body as Body).filter((p) => p !== 'move').length;
        const move = countPart(body as Body, 'move');
        const label = `${JSON.stringify(ratio)} @ ${String(budget)}`;
        expect(move, `${label}: ${String(nonMove)} non-MOVE vs ${String(move)} MOVE`).toBeGreaterThanOrEqual(nonMove);
      }
    }
  });

  it('builds a slow creep rather than none when the fast one is unaffordable', () => {
    // Movement balance is a preference, not a hard requirement. Refusing here
    // would deadlock the worst case: a room whose harvester just died with less
    // banked energy than the balanced replacement costs has no income, so it
    // could never afford to recover.
    const body = designBody(200, { work: 1, carry: 1, move: 2 });

    expect(body).not.toBeNull();
    expect(bodyCost(body as Body)).toBeLessThanOrEqual(200);
    expect(countPart(body as Body, 'work')).toBeGreaterThan(0);
    expect(countPart(body as Body, 'move')).toBeGreaterThan(0);
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
    const body = designBody(600, { work: 2, carry: 1, move: 3 });
    expect(body).not.toBeNull();
    expect(countPart(body as Body, 'work')).toBe(2);
    expect(bodyCost(body as Body)).toBe(400);
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
  it('gives every role a body that can move at full speed', () => {
    // A slow body is the failure mode that is invisible in unit terms and
    // expensive in practice, so every role is held to the 1-tick-per-tile bar.
    for (const role of Object.keys(ROLE_RATIO)) {
      const body = designForRole(role, 600);
      expect(body, role).not.toBeNull();

      const nonMove = (body as Body).filter((p) => p !== 'move').length;
      const move = countPart(body as Body, 'move');
      expect(move, `${role}: ${String(nonMove)} non-MOVE vs ${String(move)} MOVE`).toBeGreaterThanOrEqual(nonMove);
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
