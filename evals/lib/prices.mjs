// First-party list prices, $ per million tokens (from the claude-api skill's
// model table, cached 2026-11-03). Cache writes are priced at 1.25x input
// (5-minute TTL) and reads at 0.1x input. Claude Code may use the 1-hour TTL
// (2x input) for some writes, so cost_usd here can run slightly low; the
// figure Claude Code itself reports is kept beside it as cc_cost_usd.
export const PRICES = {
  'claude-fable-5-2': [8, 40],
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

export function priceFor(model) {
  if (!model) return null;
  const key = Object.keys(PRICES).sort((a, b) => b.length - a.length).find(k => model.startsWith(k));
  return key ? PRICES[key] : null;
}

export function costUsd(model, u) {
  const p = priceFor(model);
  if (!p || !u) return null;
  const [inp, out] = p;
  return ((u.input_tokens || 0) * inp
    + (u.cache_creation_input_tokens || 0) * inp * 1.25
    + (u.cache_read_input_tokens || 0) * inp * 0.1
    + (u.output_tokens || 0) * out) / 1e6;
}
