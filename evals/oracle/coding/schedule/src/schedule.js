const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const runIn = (y, m, day) => new Date(Date.UTC(y, m, Math.min(day, lastDay(y, m))));

export function nextMonthlyRun(from, dayOfMonth) {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  let candidate = runIn(y, m, dayOfMonth);
  if (candidate <= from) candidate = runIn(y, m + 1, dayOfMonth);
  return candidate;
}

export function upcomingRuns(from, dayOfMonth, count) {
  const runs = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    cursor = nextMonthlyRun(cursor, dayOfMonth);
    runs.push(cursor);
  }
  return runs;
}
