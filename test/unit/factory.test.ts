import { describe, expect, it } from 'vitest';
import { chooseCommodity, FACTORY_ENERGY_FLOOR, FACTORY_MINERAL_FLOOR, FACTORY_OUTPUT_CAP } from '../../src/domain/factory';
import { factorySite } from '../../src/domain/planning';

describe('bar commodity choice (M6-7)', () => {
  it('picks the bar when mineral and energy clear the floors', () => {
    const commodity = chooseCommodity({ stock: { U: FACTORY_MINERAL_FLOOR, energy: FACTORY_ENERGY_FLOOR } });
    expect(commodity?.bar).toBe('utrium_bar');
    expect(commodity?.amount).toBe(100);
  });
  it('refuses to run below floors or on an oversupplied product', () => {
    expect(chooseCommodity({ stock: { U: FACTORY_MINERAL_FLOOR - 1, energy: 5000 } })).toBeUndefined();
    expect(chooseCommodity({ stock: { U: 5000, energy: FACTORY_ENERGY_FLOOR - 1 } })).toBeUndefined();
    expect(chooseCommodity({ stock: { U: 5000, energy: 5000, utrium_bar: FACTORY_OUTPUT_CAP } })).toBeUndefined();
  });
  it('is deterministic across the bar table order', () => {
    const mixed = { U: 1000, L: 5000, energy: 5000 } as Record<string, number>;
    expect(chooseCommodity({ stock: mixed })?.bar).toBe('utrium_bar');
    const onlyL = { L: 5000, energy: 5000 } as Record<string, number>;
    expect(chooseCommodity({ stock: onlyL })?.bar).toBe('lemergium_bar');
  });
});

describe('factory site (M6-7)', () => {
  it('anchors on the terminal one ring outside the lab cluster', () => {
    const free = () => true;
    const site = factorySite({ anchor: { x: 23, y: 23 }, factories: [], free });
    expect(site).toBeDefined();
    expect(Math.max(Math.abs(site!.x - 23), Math.abs(site!.y - 23))).toBeLessThanOrEqual(4);
  });
  it('skips occupied tiles and never returns the anchor itself', () => {
    const occupied = new Set(['23,23', '22,23', '24,23', '23,22', '23,24', '21,23', '25,23', '23,21', '23,25']);
    const free = (x: number, y: number) => !occupied.has(`${x},${y}`);
    const site = factorySite({ anchor: { x: 23, y: 23 }, factories: [], free });
    expect(site).toBeDefined();
    expect(occupied.has(`${site!.x},${site!.y}`)).toBe(false);
  });
  it('returns undefined without an anchor', () => {
    expect(factorySite({ factories: [], free: () => true })).toBeUndefined();
  });
});
