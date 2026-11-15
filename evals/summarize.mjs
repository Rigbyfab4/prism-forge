#!/usr/bin/env node
// Summarize a flow: per-arm quality with 95% bootstrap CIs, paired deltas vs
// baseline, per-category breakdown, cost/context/latency as absolute numbers,
// and manipulation checks (did each arm behave like the arm it claims to be?).
// Every number is recomputed from results.jsonl; nothing is read from caches.
//
//   node summarize.mjs [--flow flow]      -> prints and writes <flow>/summary.md

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getArm } from './lib/arms.mjs';
import { costUsd } from './lib/prices.mjs';
import { EVAL_ROOT } from './lib/source.mjs';

const argv = process.argv.slice(2);
const flow = argv.includes('--flow') ? argv[argv.indexOf('--flow') + 1] : 'flow';
const dir = join(EVAL_ROOT, flow);
const st = JSON.parse(readFileSync(join(dir, '_state.json'), 'utf8'));
const variants = Object.keys(st.arms).filter(v => existsSync(join(dir, v, 'results.jsonl')));
const metricIds = (st.metrics || []).map(m => m.id);

const readJsonl = (p) => existsSync(p)
  ? readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } })
  : [];

// Seeded RNG so the CIs don't wobble between runs of this script
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const median = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function bootCI(xs, iters = 4000) {
  if (xs.length < 2) return [NaN, NaN];
  const ms = [];
  for (let i = 0; i < iters; i++) { let s = 0; for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rand() * xs.length)]; ms.push(s / xs.length); }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor(iters * 0.025)], ms[Math.floor(iters * 0.975)]];
}
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '–');
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
const money = (x) => (Number.isFinite(x) ? `$${x.toFixed(x < 0.1 ? 4 : 3)}` : '–');
const int = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '–');

// rows[variant][case] = [rep rows]
const rows = {}, errors = {};
for (const v of variants) {
  rows[v] = {};
  for (const r of readJsonl(join(dir, v, 'results.jsonl'))) {
    if (r.status && r.status !== 'ok') continue;
    (rows[v][r.prompt_id] ??= []).push(r);
  }
  errors[v] = readJsonl(join(dir, v, 'errors.jsonl'));
}
const caseMean = (reps, key) => mean(reps.map(r => key.startsWith('grade.') ? r.grade?.[key.slice(6)] : r[key]).filter(x => typeof x === 'number'));
const category = (reps) => reps[0]?.tags?.[0] ?? 'other';

const out = [];
const p = (s = '') => out.push(s);
p(`# ${st.flow ?? flow}: summary`);
p();
p(`${st.description ?? ''}`);
p();
p('| variant | arm | cases | reps | errors |');
p('|---|---|---|---|---|');
for (const v of variants) {
  const reps = Object.values(rows[v]).reduce((n, r) => n + r.length, 0);
  const byClass = {};
  for (const e of errors[v]) byClass[e.failure_class] = (byClass[e.failure_class] || 0) + 1;
  p(`| ${v} | ${getArm(st.arms[v]).label} | ${Object.keys(rows[v]).length} | ${reps} | ${errors[v].length ? Object.entries(byClass).map(([k, n]) => `${k}: ${n}`).join(', ') : 0} |`);
}

// --- quality ----------------------------------------------------------------
const base = variants[0];
p();
p('## Quality');
p();
p('Case-level means (reps averaged within a case first), with 95% bootstrap CIs over cases. ' +
  '"Δ vs ' + base + '" is the paired per-case difference. A CI that includes 0 means no detectable difference at this sample size.');
p();
for (const m of metricIds) {
  p(`### ${(st.metrics.find(x => x.id === m)?.label) ?? m}`);
  p();
  p(`| variant | mean | 95% CI | Δ vs ${base} | Δ 95% CI | n |`);
  p('|---|---|---|---|---|---|');
  for (const v of variants) {
    const vals = [], deltas = [];
    for (const [id, reps] of Object.entries(rows[v])) {
      const x = caseMean(reps, `grade.${m}`);
      if (!Number.isFinite(x)) continue;
      vals.push(x);
      const b = rows[base][id] ? caseMean(rows[base][id], `grade.${m}`) : NaN;
      if (Number.isFinite(b) && v !== base) deltas.push(x - b);
    }
    const [lo, hi] = bootCI(vals);
    const [dlo, dhi] = bootCI(deltas);
    p(`| ${v} | ${f2(mean(vals))} | ${f2(lo)}–${f2(hi)} | ${v === base ? '—' : f2(mean(deltas))} | ${v === base ? '—' : `${f2(dlo)}–${f2(dhi)}`} | ${vals.length} |`);
  }
  p();
}
if (metricIds.includes('win')) {
  p('`win`: blind pairwise judgment against the frozen ' + base + ' output, judged in both orders; 1 = preferred both times, 0.5 = tie or split, 0 = ' + base + ' preferred both times. ' + base + ' is 0.5 by definition.');
  const agree = [];
  for (const v of variants.slice(1)) for (const reps of Object.values(rows[v])) for (const r of reps) {
    const e = r.explanation?.win; if (e) agree.push(/orders agree/.test(e) ? 1 : 0);
  }
  if (agree.length) p(`Judge order consistency: ${pct(mean(agree))} of pairwise judgments agreed across both orders (low agreement = position bias or near-ties).`);
  p();
}

// --- per category -------------------------------------------------------------
const cats = [...new Set(Object.values(rows[base]).map(category))].sort();
if (cats.length > 1) {
  p('## By category');
  p();
  const head = metricIds.includes('win') ? 'win' : metricIds[0];
  p(`Mean \`${head}\` per category (n = cases). Small n: read as direction, not proof.`);
  p();
  p(`| category | n | ${variants.join(' | ')} |`);
  p(`|---|---|${variants.map(() => '---').join('|')}|`);
  for (const c of cats) {
    const ids = Object.entries(rows[base]).filter(([, r]) => category(r) === c).map(([id]) => id);
    p(`| ${c} | ${ids.length} | ${variants.map(v => f2(mean(ids.map(id => rows[v][id] ? caseMean(rows[v][id], `grade.${head}`) : NaN).filter(Number.isFinite)))).join(' | ')} |`);
  }
  p();
}

// --- cost, context, behaviour -----------------------------------------------
p('## Cost, context and behaviour');
p();
p('Absolute numbers per session (median over all reps). "Start context" is the input size of the first model request: system prompt, CLAUDE.md, auto-loaded rules and hook context. It is where Prism\'s context overhead shows up.');
p();
p('| variant | cost | Claude Code reported cost | judge cost | start context (tok) | out tok | latency s | words | tool calls | turns with persona tags | first turn sitrep |');
p('|---|---|---|---|---|---|---|---|---|---|---|');
const perfOf = {};
for (const v of variants) {
  const all = Object.values(rows[v]).flat();
  const col = (k) => all.map(r => r[k]).filter(x => typeof x === 'number');
  const judgeCost = all.map(r => (r.judge_usage && r.judge_model && r.judge_model !== 'mock') ? costUsd(r.judge_model, r.judge_usage) : null).filter(x => x != null);
  perfOf[v] = { ctx: median(col('first_ctx_tokens')), tagged: mean(col('tagged_turns')), sitrep: mean(col('sitrep')) };
  p(`| ${v} | ${money(median(col('cost_usd')))} | ${money(median(col('cc_cost_usd')))} | ${money(median(judgeCost))} | ${int(perfOf[v].ctx)} | ${int(median(col('out_tokens')))} | ${f2(median(col('latency_s')))} | ${int(median(col('words')))} | ${f2(mean(col('tool_calls')))} | ${pct(perfOf[v].tagged)} | ${pct(perfOf[v].sitrep)} |`);
}
p();
const totals = variants.map(v => Object.values(rows[v]).flat().reduce((s, r) => s + (r.cost_usd || 0) + ((r.judge_usage && r.judge_model !== 'mock') ? (costUsd(r.judge_model, r.judge_usage) || 0) : 0), 0));
p(`Measured spend for this flow (runs + judge, scored rows only): ${money(totals.reduce((a, b) => a + b, 0))}.`);
p();

// --- manipulation checks ------------------------------------------------------
p('## Did each arm behave like itself?');
p();
const notes = [];
for (const v of variants) {
  const armId = st.arms[v];
  const { ctx, tagged } = perfOf[v];
  const shouldBeOn = armId !== 'none' && armId !== 'prism-toggle-off';
  if (shouldBeOn && st.cases_dir === 'cases' && tagged < 0.2) notes.push(`- **${v} (${armId})**: persona tags on only ${pct(tagged)} of turns. Prism's instructions may not be reaching the model; any "no difference" result for this arm says little about Prism itself. Check the debug-log excerpt at the end of a trace.`);
  if (!shouldBeOn && tagged > 0.05) notes.push(`- **${v} (${armId})**: persona tags on ${pct(tagged)} of turns although Prism should be off here.`);
  if (v !== base && Number.isFinite(ctx) && Number.isFinite(perfOf[base].ctx)) {
    notes.push(`- ${v} starts each session with ${int(ctx - perfOf[base].ctx)} more context tokens than ${base} (median ${int(ctx)} vs ${int(perfOf[base].ctx)}).`);
  }
}
p(notes.length ? notes.join('\n') : 'No anomalies detected.');
p();

// --- per-check pass rates (toggle flow and coding diagnostics) ---------------
const checkRates = {};
for (const v of variants) for (const [id, reps] of Object.entries(rows[v])) for (const r of reps) {
  for (const line of (r.explanation?.checks || '').split('\n')) {
    const m = /^(PASS|FAIL) ([^:]+):/.exec(line); if (!m) continue;
    const k = `${id} / ${m[2]}`; ((checkRates[k] ??= {})[v] ??= []).push(m[1] === 'PASS' ? 1 : 0);
  }
}
if (Object.keys(checkRates).length) {
  p('## Check pass rates');
  p();
  p(`| case / check | ${variants.join(' | ')} |`);
  p(`|---|${variants.map(() => '---').join('|')}|`);
  for (const [k, by] of Object.entries(checkRates).sort()) p(`| ${k} | ${variants.map(v => by[v] ? `${pct(mean(by[v]))} (${by[v].length})` : '–').join(' | ')} |`);
  p();
}

const md = out.join('\n');
writeFileSync(join(dir, 'summary.md'), md + '\n');
console.log(md);
