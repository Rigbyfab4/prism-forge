import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/duration.js';

const ok = { '2h': 7200, '1h30m': 5400, '1H 5m 10s': 3910, '0s': 0, '90m': 5400, '45s': 45, '  2h  ': 7200, '1m1s': 61, '10h 0m': 36000 };
for (const [input, want] of Object.entries(ok)) {
  test(`parses ${JSON.stringify(input)}`, () => assert.equal(parseDuration(input), want));
}
for (const bad of ['', '   ', '10', '5x', 'h', '1m1h', '1h1h', '-5s', '1.5h', '1h 2', 'abc']) {
  test(`rejects ${JSON.stringify(bad)}`, () => assert.throws(() => parseDuration(bad), TypeError));
}
