import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextMonthlyRun, upcomingRuns } from '../src/schedule.js';

const d = (s) => new Date(s);
const iso = (x) => x.toISOString().slice(0, 10);
const cases = [
  ['2026-01-31T00:00:00Z', 31, '2026-02-28'],
  ['2026-02-10T00:00:00Z', 31, '2026-02-28'],
  ['2026-02-28T00:00:00Z', 31, '2026-03-31'],
  ['2028-01-31T00:00:00Z', 31, '2028-02-29'],
  ['2026-12-31T00:00:00Z', 31, '2027-01-31'],
  ['2026-04-30T12:00:00Z', 30, '2026-05-30'],
  ['2026-01-30T00:00:00Z', 30, '2026-02-28'],
  ['2026-03-14T00:00:00Z', 15, '2026-03-15'],
  ['2026-03-15T00:00:00Z', 15, '2026-04-15'],
];
for (const [from, day, want] of cases) {
  test(`next run after ${from} on day ${day}`, () => assert.equal(iso(nextMonthlyRun(d(from), day)), want));
}
test('a day-31 job runs every month for a year', () => {
  const runs = upcomingRuns(d('2026-01-01T00:00:00Z'), 31, 12).map(iso);
  assert.deepEqual(runs, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
    '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']);
});
