import { afterEach, describe, expect, it } from 'vitest';
import { LINK_CAPACITY, LINK_SEND_THRESHOLD, linkTransfers, type LinkNode } from '../../src/domain/links';

afterEach(() => {});

const node = (id: string, role: 'source' | 'hub', over: Partial<LinkNode> = {}): LinkNode => ({
  id, role, energy: 0, free: role === 'hub' ? LINK_CAPACITY : LINK_CAPACITY, cooldown: 0, ...over,
});

describe('link transfers (M6-2)', () => {
  it('sends a full source link to an idle hub, net of the loss headroom', () => {
    const plan = linkTransfers([node('src', 'source', { energy: 800 }), node('hub', 'hub', { free: 800 })]);
    expect(plan).toEqual([{ from: 'src', to: 'hub', amount: 800 }]);
  });

  it('holds below the half-cap threshold', () => {
    const plan = linkTransfers([node('src', 'source', { energy: LINK_SEND_THRESHOLD - 1 }), node('hub', 'hub')]);
    expect(plan).toEqual([]);
  });

  it('respects cooldowns on both ends', () => {
    expect(linkTransfers([node('src', 'source', { energy: 800, cooldown: 1 }), node('hub', 'hub')])).toEqual([]);
    expect(linkTransfers([node('src', 'source', { energy: 800 }), node('hub', 'hub', { cooldown: 5 })])).toEqual([]);
  });

  it('caps the amount by the hub headroom and skips saturated hubs', () => {
    const tight = linkTransfers([node('src', 'source', { energy: 800 }), node('hub', 'hub', { free: 100 })]);
    expect(tight[0]?.amount).toBe(Math.floor(100 / 0.97));
    const saturated = linkTransfers([node('src', 'source', { energy: 800 }), node('hub', 'hub', { free: 0 })]);
    expect(saturated).toEqual([]);
  });

  it('never routes hub-to-hub and caps one reception per hub per plan', () => {
    const plan = linkTransfers([
      node('h1', 'hub', { energy: 800, free: 0 }),
      node('src1', 'source', { energy: 800 }),
      node('src2', 'source', { energy: 500 }),
      node('hub2', 'hub', { free: 200 }),
    ]);
    expect(plan).toEqual([{ from: 'src1', to: 'hub2', amount: Math.floor(200 / 0.97) }]);
  });
});
