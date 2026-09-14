import { expect, it } from 'vitest';
// @ts-expect-error Node-side ESM helper is checked by ESLint and exercised here.
import { candidateRooms, evaluateRoom } from '../../scripts/lib/room-selector.mjs';

const objects = [{ type: 'controller', x: 10, y: 10 }, { type: 'source', x: 15, y: 15 }, { type: 'source', x: 35, y: 35 }];
it('scans ordinary rooms around recommended sector centers', () => {
  expect(candidateRooms(['W35S5'])).toEqual(['W32S5', 'W35S2', 'W35S8', 'W38S5']);
});
it('selects a connected plain tile away from source and controller positions', () => {
  const result = evaluateRoom('W32S5', '0'.repeat(2500), objects, { status: 'normal' });
  expect(result.eligible).toBe(true);
  expect(result.sources).toBe(2);
  expect(result.space).toBe(49);
  expect(result.controllerDistance).toBeGreaterThanOrEqual(2);
});
it('rejects unknown, occupied and disconnected rooms', () => {
  expect(evaluateRoom('W32S5', null, objects, { status: 'normal' }).eligible).toBe(false);
  expect(evaluateRoom('W32S5', '0'.repeat(2500), [{ ...objects[0], user: 'enemy' }, objects[1]], { status: 'normal' }).eligible).toBe(false);
  expect(evaluateRoom('W32S5', '1'.repeat(2500), objects, { status: 'normal' }).eligible).toBe(false);
  expect(evaluateRoom('W35S5', '0'.repeat(2500), objects.slice(1), { status: 'normal' }).eligible).toBe(false);
});
