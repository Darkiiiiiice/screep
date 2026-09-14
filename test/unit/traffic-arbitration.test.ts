import { describe, expect, it } from 'vitest';
import { arbitrateMoves } from '../../src/domain/traffic';

describe('traffic arbitration', () => {
  it('allows swaps and complete rotations', () => {
    expect([...arbitrateMoves([
      { name: 'a', from: '1', to: '2', priority: 0 },
      { name: 'b', from: '2', to: '1', priority: 0 },
    ], { '1': 'a', '2': 'b' })].sort()).toEqual(['a', 'b']);
  });
  it('blocks every member of a chain ending in a stationary occupant', () => {
    expect(arbitrateMoves([
      { name: 'a', from: '1', to: '2', priority: 0 },
      { name: 'b', from: '2', to: '3', priority: 0 },
    ], { '1': 'a', '2': 'b', '3': 'c' }).size).toBe(0);
  });
  it('gives a contested tile to the waiting creep and releases a following chain', () => {
    expect([...arbitrateMoves([
      { name: 'a', from: '1', to: '3', priority: 0 },
      { name: 'b', from: '2', to: '3', priority: 4 },
      { name: 'c', from: '4', to: '2', priority: 0 },
    ], { '1': 'a', '2': 'b', '4': 'c' })].sort()).toEqual(['b', 'c']);
  });
});
