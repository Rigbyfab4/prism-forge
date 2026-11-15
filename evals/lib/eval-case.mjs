// The eval-specific half of run-eval.mjs: load cases, run one case through
// Claude Code in an isolated home for the variant's arm, and grade it.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getArm, prismCli, prismStatus } from './arms.mjs';
import { digest, readIfExists, runSession, toTranscript } from './claude.mjs';
import { blind, countPersonaTags, hasSitrep, runChecks, words } from './checks.mjs';
import { judgePair, judgeRubric, renderConversation, renderResponse, USAGE_LIMIT } from './judge.mjs';
import { costUsd } from './prices.mjs';
import { EVAL_ROOT } from './source.mjs';
import { assertTempRootClean, makeTemp } from './tmp.mjs';

const KEEP = process.env.EVAL_KEEP === '1';
const DIFF_FOR_JUDGE = 15_000;

// Tools a coding case may use without a prompt. Edits are limited to the
// throwaway workspace by acceptEdits; Bash is limited to these commands.
const CODING_ALLOWED = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(node:*)', 'Bash(npm test:*)', 'Bash(npm run test:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)', 'Bash(cat:*)',
];

export async function loadCases(ctx) {
  const st = ctx.state;
  if (!st.cases_dir) throw new Error('_state.json needs "cases_dir"');
  if (!st.arms?.[ctx.variant]) throw new Error(`_state.json "arms" has no entry for variant '${ctx.variant}'`);
  getArm(st.arms[ctx.variant]); // fail before spending if the arm id is wrong
  if (!ctx.model) throw new Error('pass --model (the model Claude Code runs under test)');
  assertTempRootClean();
  const dir = join(EVAL_ROOT, st.cases_dir);
  const cases = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    for (const c of JSON.parse(readFileSync(join(dir, f), 'utf8'))) {
      const turns = c.turns.map(t => (typeof t === 'string' ? { text: t } : t));
      cases.push({
        ...c, turns,
        tags: [c.category, ...(c.tags || [])],
        prompt: turns.map(t => t.text ?? `[${t.control}: ${t.command ?? ''}]`).join('\n\n---\n\n'),
      });
    }
  }
  // EVAL_ONLY=id1,id2 or a category name, for pilots
  const only = process.env.EVAL_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  const selected = only?.length ? cases.filter(c => only.includes(c.id) || only.includes(c.category)) : cases;
  // Non-baseline variants are judged against baseline's frozen outputs: refuse
  // before spending anything if any are missing
  if (ctx.variant !== 'baseline' && st.judge !== false) {
    const missing = selected.filter(c => c.rubric?.length && !existsSync(join(ctx.flow, 'baseline', 'ref', c.id)));
    if (missing.length) {
      throw new Error(`baseline has no frozen output yet for ${missing.length} case(s) (${missing.slice(0, 5).map(c => c.id).join(', ')}${missing.length > 5 ? ', ...' : ''}). Run --variant baseline for them first.`);
    }
  }
  return selected;
}

const sh = (cmd, args, cwd, timeout = 120_000) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, windowsHide: true });

function gitInit(ws) {
  const g = (...a) => sh('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', ...a], ws);
  if (g('init', '-q').status !== 0) return false;
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture', '--allow-empty');
  return true;
}

function collectCoding(c, ws) {
  const out = { changedFiles: [], diff: '', tests: null, commands: {} };
  sh('git', ['add', '-A'], ws);
  const names = sh('git', ['diff', '--cached', '--name-only'], ws).stdout || '';
  out.changedFiles = names.split(/\r?\n/).filter(Boolean);
  out.diff = sh('git', ['diff', '--cached'], ws).stdout || '';
  out.diffStat = (sh('git', ['diff', '--cached', '--shortstat'], ws).stdout || '').trim();
  // Line counts before/after for files a check names (no-op and bloat detection)
  out.lineCounts = {};
  for (const ck of c.checks || []) {
    if (ck.type !== 'line_count_max') continue;
    const count = (t) => (t.match(/\n/g) || []).length + (t && !t.endsWith('\n') ? 1 : 0);
    const before = count(readFileSync(join(EVAL_ROOT, 'fixtures', c.workspace, ck.path), 'utf8'));
    const after = existsSync(join(ws, ck.path)) ? count(readFileSync(join(ws, ck.path), 'utf8')) : Infinity;
    out.lineCounts[ck.path] = { before, after };
  }
  if (c.hidden) {
    // Copied in only now, after the session ended: the agent never saw them
    const dest = join(ws, '__hidden_tests__');
    cpSync(join(EVAL_ROOT, 'hidden', c.hidden), dest, { recursive: true });
    const files = readdirSync(dest).filter(f => f.endsWith('.test.js')).map(f => join('__hidden_tests__', f));
    const r = sh(process.execPath, ['--test', '--test-reporter=tap', ...files], ws);
    const num = (k) => Number((r.stdout.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] ?? NaN);
    const passed = num('pass'), failed = num('fail');
    out.tests = {
      pass: r.status === 0 && failed === 0 && passed > 0,
      passed, total: passed + failed,
      output: (r.stdout + r.stderr).slice(-6000),
    };
  }
  for (const cmd of c.commands || []) {
    const r = sh(cmd.argv[0] === 'node' ? process.execPath : cmd.argv[0], cmd.argv.slice(1), ws, cmd.timeout_ms ?? 120_000);
    out.commands[cmd.id] = {
      ok: r.status === 0,
      summary: `exit ${r.status}${r.error ? ` (${r.error.code})` : ''}`,
      output: ((r.stdout || '') + (r.stderr || '')).slice(-3000),
    };
  }
  return out;
}

function debugExcerpt(path) {
  const log = readIfExists(path);
  if (!log) return { lines: 0, excerpt: '(no debug log)' };
  const hits = log.split(/\r?\n/).filter(l => /hook|prism|plugin|additionalContext/i.test(l));
  return { lines: hits.length, excerpt: hits.slice(0, 150).join('\n').slice(0, 20_000) };
}

export async function runCase(c, ctx) {
  const armId = ctx.state.arms[ctx.variant];
  const arm = getArm(armId);
  if (c.arms && !c.arms.includes(armId)) {
    throw Object.assign(new Error(`case ${c.id} is not meant for arm ${armId}`), { failure_class: 'harness' });
  }
  const home = makeTemp('pfe-home-');
  const ws = makeTemp('pfe-ws-');
  try {
    const setup = arm.setup(home, { refs: ctx.state.refs });
    if (c.workspace) {
      cpSync(join(EVAL_ROOT, 'fixtures', c.workspace), ws, { recursive: true });
    }
    gitInit(ws);

    // Web tools are off unless the case asks for them ("web": true), and a
    // case's setting is the same in every arm, so arms stay comparable
    // Each arm may read its own ~/.claude (Prism's persona and routing files
    // live there). Headless sessions otherwise deny reads outside the working
    // folder, which in interactive use the person would simply approve.
    const args = ['--strict-mcp-config', '--add-dir', join(home, '.claude')];
    const allowed = [...(c.workspace ? CODING_ALLOWED : []), ...(c.web ? ['WebSearch', 'WebFetch'] : [])];
    if (!c.web) args.push('--disallowedTools', 'WebSearch', 'WebFetch');
    if (c.workspace) args.push('--permission-mode', 'acceptEdits');
    if (allowed.length) args.push('--allowedTools', ...allowed);
    for (const d of setup.pluginDirs || []) args.push('--plugin-dir', d);

    // Toggle turns: verify the switch really happened before the next prompt
    const toggles = [];
    const onControl = async (t, i) => {
      if (!setup.srcDir) throw Object.assign(new Error(`control turn on arm ${armId}, which has no prism CLI`), { failure_class: 'harness' });
      if (t.control === 'cli') {
        const r = prismCli(setup.srcDir, home, t.command);
        if (!r.ok) throw Object.assign(new Error(`prism-forge ${t.command} failed: ${r.out.slice(0, 300)}`), { failure_class: 'toggle_not_applied' });
      }
      const now = prismStatus(setup.srcDir, home);
      toggles.push({ turn: i + 1, via: t.control, want: t.expect, got: now });
      if (t.expect && now !== t.expect) {
        throw Object.assign(new Error(`turn ${i + 1}: after ${t.control} '${t.text ?? t.command}' Prism reports '${now}', expected '${t.expect}'`), { failure_class: 'toggle_not_applied' });
      }
    };

    const debugFile = join(home, 'claude-debug.log');
    const timeoutMs = Math.max(60_000, (ctx.timeoutS || 1800) * 1000 - 30_000);
    const t0 = Date.now();
    let sess;
    try {
      sess = await runSession({ home, cwd: ws, model: ctx.model, args, turns: c.turns, onControl, timeoutMs, debugFile });
    } catch (e) {
      e.failure_class ??= 'harness';
      throw e;
    }
    const wall_s = (Date.now() - t0) / 1000;

    for (const [i, t] of c.turns.entries()) {
      if (t.control === 'cli') continue;
      const r = sess.turnResults[i];
      if (!r) {
        throw Object.assign(new Error(`turn ${i + 1} got no result (exit ${sess.exitCode}): ${sess.stderr.slice(-800)}`), { failure_class: USAGE_LIMIT.test(sess.stderr) ? 'usage_limit' : 'claude_error' });
      }
      if (r.is_error || (r.subtype && r.subtype !== 'success')) {
        const text = String(r.result ?? '').slice(0, 300);
        // A subscription usage limit resets in hours: classify it so the run
        // can simply be resumed later (failed attempts are retried on rerun)
        throw Object.assign(new Error(`turn ${i + 1}: ${r.subtype} ${text}`), { failure_class: USAGE_LIMIT.test(text) ? 'usage_limit' : 'claude_error' });
      }
    }

    const d = digest(sess.events, c.turns);
    const coding = c.workspace ? collectCoding(c, ws) : null;
    const dbg = debugExcerpt(debugFile);
    const graded = d.perTurn.filter(t => !t.control);
    const allText = graded.map(t => t.text).join('\n\n');
    const lastResult = sess.turnResults.filter(Boolean).at(-1);
    // Each turn's own result event, kept raw: whether Claude Code reports usage
    // and cost per turn or cumulatively in stream-json is checked from these
    const turnTotals = sess.turnResults.map((r, i) => (r && !r.control)
      ? { turn: i + 1, cost: r.total_cost_usd ?? null, out: r.usage?.output_tokens ?? null, in: r.usage?.input_tokens ?? null,
          cache_read: r.usage?.cache_read_input_tokens ?? null, cache_write: r.usage?.cache_creation_input_tokens ?? null }
      : null).filter(Boolean);
    // A single answered turn makes the result event authoritative for output
    const outTokens = turnTotals.length === 1 && Number.isFinite(turnTotals[0].out)
      ? Math.max(turnTotals[0].out, d.usage.output_tokens) : d.usage.output_tokens;
    if (outTokens !== d.usage.output_tokens) d.usage.output_tokens = outTokens;

    const transcript = [
      { role: 'system', content: `[harness] arm=${armId} (${arm.label}); model=${ctx.model}; plugin dirs: ${(setup.pluginDirs || []).length}; toggles: ${JSON.stringify(toggles)}` },
      ...toTranscript(sess.events),
      ...(coding ? [{ role: 'system', content: `[harness] diff ${coding.diffStat || '(none)'}\nchanged: ${coding.changedFiles.join(', ')}\n\nhidden tests:\n${coding.tests?.output ?? 'n/a'}\n\n${coding.diff.slice(0, 20_000)}` }] : []),
      { role: 'system', content: `[harness] per-turn result events: ${JSON.stringify(turnTotals)}` },
      { role: 'system', content: `[harness] debug log: ${dbg.lines} hook/plugin lines\n${dbg.excerpt}` },
    ];

    return {
      model: d.model,
      usage: d.usage,
      stop_reason: 'end_turn',
      perTurn: d.perTurn,
      coding,
      transcript,
      output: JSON.stringify({
        turns: d.perTurn.map(t => ({ user: t.user, control: t.control, text: t.text })),
        diff: coding ? coding.diff.slice(0, DIFF_FOR_JUDGE) : undefined,
      }),
      perf: {
        cost_usd: costUsd(d.model, d.usage),
        cc_cost_usd: lastResult?.total_cost_usd ?? null,
        cc_cost_sum: turnTotals.reduce((a, t) => a + (t.cost || 0), 0) || null,
        first_ctx_tokens: d.firstCtx,
        out_tokens: d.usage.output_tokens,
        tool_calls: graded.reduce((n, t) => n + t.toolCalls, 0),
        api_calls: d.apiCalls,
        words: words(allText),
        persona_tags: countPersonaTags(allText),
        tagged_turns: graded.filter(t => countPersonaTags(t.text) > 0).length / Math.max(1, graded.length),
        sitrep: hasSitrep(graded[0]?.text ?? '') ? 1 : 0,
        debug_hook_lines: dbg.lines,
        wall_s,
      },
    };
  } finally {
    if (!KEEP) {
      // A failed cleanup (e.g. read-only .git files on Windows) must not turn
      // a finished, paid case into an error
      for (const d of [home, ws]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); }
        catch (e) { console.error(`warning: could not remove temp folder ${d}: ${e.code || e.message}`); }
      }
    }
  }
}

function diffBlock(diff) {
  return diff ? `[Code changes made in the repository]\n${diff.slice(0, DIFF_FOR_JUDGE)}` : '';
}

export async function gradeCase(c, run, ref, ctx) {
  const checks = runChecks(c, run);
  const grade = { checks: checks.score };
  const explanation = { checks: checks.results.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.id}: ${r.detail}`).join('\n') || 'no checks' };

  const judgeOn = ctx.state.judge !== false && (c.rubric?.length || 0) > 0;
  if (!judgeOn) return { grade, explanation };

  const model = process.env.EVAL_JUDGE_MODEL || ctx.state.judge_model || 'claude-opus-5-5';
  const usage = {};
  const conversation = renderConversation(run.perTurn);
  const response = blind(renderResponse(run.perTurn, diffBlock(run.coding?.diff)));
  try {
    const rub = await judgeRubric({ model, c, conversation, response, usage });
    grade.rubric = rub.score;
    explanation.rubric = rub.criteria.map(x => `${x.met ? 'MET' : 'MISSED'} ${x.id}: ${x.reason}`).join('\n');

    if (ctx.variant === 'baseline') {
      grade.win = 0.5; // the reference itself: neutral by definition
      explanation.win = 'baseline (reference) row';
    } else {
      if (ref == null) {
        throw Object.assign(new Error(`no frozen baseline output for ${c.id}: run --variant baseline first`), { failure_class: 'harness' });
      }
      const r = JSON.parse(ref);
      const reference = blind(renderResponse(r.turns, diffBlock(r.diff)));
      const pair = await judgePair({ model, c, conversation, candidate: response, reference, usage });
      grade.win = pair.win;
      explanation.win = `win ${pair.win} (orders ${pair.consistent ? 'agree' : 'disagree'})\n[candidate as A] ${pair.orders[0]}\n[candidate as B] ${pair.orders[1]}`;
    }
    return { grade, explanation, judge_model: rub.model === 'mock' ? 'mock' : rub.model, judge_usage: usage };
  } catch (e) {
    e.judge_model = model;
    e.judge_usage = usage;
    e.failure_class ??= 'judge_error';
    throw e;
  }
}

export function perfFrom(run) {
  return run.perf ?? {};
}
