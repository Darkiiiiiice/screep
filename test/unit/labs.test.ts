import { describe, expect, it } from 'vitest';
import { chooseRecipe, LAB_INPUT_FLOOR, LAB_OUTPUT_CAP } from '../../src/domain/labs';

describe('reaction recipe choice (M6-5)', () => {
  it('picks the first recipe with both inputs stocked and no surplus product', () => {
    expect(chooseRecipe({ stock: { U: 500, H: 500 } })).toEqual({ inputs: ['U', 'H'], out: 'UH' });
    expect(chooseRecipe({ stock: { H: 500, O: 500, U: 500 } })).toEqual({ inputs: ['H', 'O'], out: 'OH' });
  });
  it('refuses to burn a single-mineral stockpile', () => {
    expect(chooseRecipe({ stock: { U: 5000 } })).toBeUndefined();
    expect(chooseRecipe({ stock: {} })).toBeUndefined();
  });
  it('honors the input floor and the output cap', () => {
    expect(chooseRecipe({ stock: { U: LAB_INPUT_FLOOR - 1, H: 500 } })).toBeUndefined();
    expect(chooseRecipe({ stock: { U: LAB_INPUT_FLOOR, H: LAB_INPUT_FLOOR, UH: LAB_OUTPUT_CAP } })).toBeUndefined();
  });
});
