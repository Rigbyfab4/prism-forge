// Behaviour must match the original implementation exactly, errors included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippingCost } from '../src/shipping.js';
import { shippingCost as original } from './original.js';

const outcome = (fn, args) => {
  try { return { value: fn(...args) }; } catch (e) { return { error: e.constructor.name }; }
};

const weights = [0.2, 1, 1.5, 3.25, 5, 5.01, 12, 40];
const countries = ['US', 'CA', 'MX', 'EU'];
const grid = [];
for (const w of weights) for (const c of countries) for (const x of [false, true]) for (const s of [0, 99.99, 100, 250]) grid.push([w, c, x, s]);

test('same cost as the original across the rate grid', () => {
  for (const args of grid) assert.deepEqual(outcome(shippingCost, args), outcome(original, args), JSON.stringify(args));
});

const invalid = [
  [0, 'US', false, 10], [-2, 'EU', true, 10], ['3', 'US', false, 10], [NaN, 'CA', false, 10],
  [2, 'US', false, -1], [2, 'US', false, NaN], [2, 'US', false, '50'], [2, 'JP', false, 10], [2, undefined, true, 10],
];
for (const args of invalid) {
  test(`same error as the original for ${JSON.stringify(args)}`, () => {
    const want = outcome(original, args);
    assert.ok(want.error, 'original should throw here');
    assert.deepEqual(outcome(shippingCost, args), want);
  });
}
