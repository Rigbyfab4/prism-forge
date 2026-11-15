export function parseDuration(str) {
  if (typeof str !== 'string') throw new TypeError('expected a string');
  const m = /^\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?\s*$/i.exec(str);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
    throw new TypeError(`invalid duration: ${JSON.stringify(str)}`);
  }
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
}
