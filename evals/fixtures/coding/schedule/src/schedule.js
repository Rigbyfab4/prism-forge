// Monthly job scheduling. All dates are UTC.
//
// nextMonthlyRun(from, dayOfMonth): the next run strictly after `from`, at
// 00:00 UTC on `dayOfMonth` (1-31). In months that don't have that day, the
// job runs on the last day of the month instead.
export function nextMonthlyRun(from, dayOfMonth) {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  let candidate = new Date(Date.UTC(y, m, dayOfMonth));
  if (candidate <= from) {
    candidate = new Date(Date.UTC(y, m + 1, dayOfMonth));
  }
  return candidate;
}

// The next `count` runs after `from`.
export function upcomingRuns(from, dayOfMonth, count) {
  const runs = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    cursor = nextMonthlyRun(cursor, dayOfMonth);
    runs.push(cursor);
  }
  return runs;
}
