#!/usr/bin/env node
// Preflight: build every arm's isolated home and check it is what it claims
// to be, without any model calls. Run this on the machine that will run the
// eval, before the first paid pass.
//
//   node preflight.mjs [--flow flow] [--keep]
//
// Checks per arm:
//   - prism CLI install/disable succeeded (setup didn't throw)
//   - CLAUDE.md has / lacks the PRISM block
//   - each registered hook command runs and what it prints for a sample prompt
//   - bytes of .md under ~/.claude/rules (Claude Code auto-loads that folder)
//   - toggle arms: `prism-forge status`, and `claude plugin validate` on the mod
// Plus environment: python on PATH (hooks call `python`, not `python3`),
// bash (hooks call `bash`), claude, and credentials for runs and the judge.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getArm, homeEnv, prismStatus } from './lib/arms.mjs';
import { digest, resolveClaude, runSession } from './lib/claude.mjs';
import { JUDGE_BACKEND, judgePair } from './lib/judge.mjs';
import { describeRef, EVAL_ROOT } from './lib/source.mjs';

const args = process.argv.slice(2);
const flow = args.includes('--flow') ? args[args.indexOf('--flow') + 1] : 'flow';
const keep = args.includes('--keep');
const live = args.includes('--live');
const st = JSON.parse(readFileSync(join(EVAL_ROOT, flow, '_state.json'), 'utf8'));
const WIN = process.platform === 'win32';
let problems = 0;
const warn = (m) => { problems++; console.log(`  !! ${m}`); };

function probe(cmd, argv) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split(/\r?\n/)[0] : null;
}

console.log('# Environment');
console.log(`  node ${process.version} on ${process.platform}`);
const py = probe('python', ['--version']);
console.log(`  python: ${py ?? 'NOT FOUND'}`);
if (!py) warn('`python` is not runnable. Prism hooks call `python` (not python3); without it the Prism arms silently lose routing. On Windows, the Microsoft Store alias does not count.');
const bash = probe('bash', ['--version']);
console.log(`  bash: ${bash ?? 'NOT FOUND'}`);
if (!bash) warn('`bash` is not runnable. Prism hooks call `bash` (Git Bash on Windows).');
try {
  const c = resolveClaude();
  console.log(`  claude: ${probe(c.cmd, [...c.pre, '--version']) ?? 'found but --version failed'} (${[c.cmd, ...c.pre].join(' ')})`);
} catch (e) { warn(e.message); }
const auth = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].filter(k => process.env[k]);
console.log(`  credentials: ${auth.join(', ') || 'NONE'}`);
if (!auth.length) warn('No credentials. Each run uses a fresh empty home that cannot see your normal Claude login: put CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY in evals/.env and run with `node --env-file=.env`.');
else console.log(`  Claude Code runs bill to: ${process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'your subscription (CLAUDE_CODE_OAUTH_TOKEN)' : 'the API key'}`);
if (st.judge !== false) console.log(`  judge backend: ${JUDGE_BACKEND}${JUDGE_BACKEND === 'claude' ? ' (claude -p with --json-schema, on the same credentials as the runs)' : JUDGE_BACKEND === 'api' ? ' (Anthropic API, ANTHROPIC_API_KEY)' : ''}`);
if (!WIN && Object.values(st.arms).some(a => a.startsWith('prism-toggle'))) {
  warn('The prism-toggle mod is written for Windows (backslash paths, node.exe); on this OS its /prism command cannot reach the CLI. Toggle results only mean something on Windows.');
}

console.log('\n# Sources');
for (const [k, ref] of Object.entries(st.refs || {})) {
  try { const d = describeRef(ref); console.log(`  ${k}: ${ref} @ ${d.sha.slice(0, 10)} "${d.subject}"`); }
  catch (e) { warn(`${k}: ${e.message}`); }
}

const SAMPLE_PROMPT = { prompt: "I'm stuck on this auth bug - tokens keep expiring early", transcript_path: '', session_id: 'preflight', cwd: tmpdir() };

function mdBytes(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += mdBytes(p);
    else if (e.name.endsWith('.md')) n += statSync(p).size;
  }
  return n;
}

function runHook(command, home, event) {
  // Commands are `python "<path>"` or `bash "<path>"`, as Prism registers them
  const m = /^(\S+)\s+"(.+)"$/.exec(command);
  if (!m) return { out: `(unrecognised command form: ${command})`, status: null };
  const input = event === 'UserPromptSubmit' ? SAMPLE_PROMPT : { session_id: 'preflight', hook_event_name: event };
  const r = spawnSync(m[1], [m[2]], { input: JSON.stringify(input), env: homeEnv(home), encoding: 'utf8', timeout: 20_000, windowsHide: true });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

for (const [variant, armId] of Object.entries(st.arms)) {
  const arm = getArm(armId);
  console.log(`\n# ${variant} = ${armId}: ${arm.label}`);
  const home = mkdtempSync(join(tmpdir(), 'pfe-pre-'));
  try {
    let setup;
    try { setup = arm.setup(home, { refs: st.refs }); }
    catch (e) { warn(`setup failed: ${String(e.stderr || e.message).slice(0, 500)}`); continue; }

    const claudeMd = existsSync(join(home, '.claude', 'CLAUDE.md')) ? readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8') : '';
    const block = claudeMd.includes('PRISM:START');
    console.log(`  CLAUDE.md PRISM block: ${block ? 'present' : 'absent'} (${claudeMd.length} bytes)`);
    console.log(`  .md auto-loaded from ~/.claude/rules: ${mdBytes(join(home, '.claude', 'rules'))} bytes`);
    console.log(`  .md in ~/.claude/prism (loaded only when read): ${mdBytes(join(home, '.claude', 'prism'))} bytes`);

    const settingsPath = join(home, '.claude', 'settings.json');
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    const hooks = settings.hooks || {};
    const events = Object.keys(hooks);
    console.log(`  registered hook events: ${events.join(', ') || 'none'}`);
    for (const ev of events) {
      for (const entry of hooks[ev]) for (const h of entry.hooks || []) {
        const r = runHook(h.command, home, ev);
        let shape = 'silent';
        if (r.out) {
          try {
            const j = JSON.parse(r.out);
            const ctx = j.hookSpecificOutput?.additionalContext;
            shape = ctx ? `hookSpecificOutput.additionalContext (${ctx.length} chars): "${ctx.slice(0, 90)}..."`
              : j.additionalContext ? `TOP-LEVEL additionalContext (undocumented shape) (${j.additionalContext.length} chars): "${j.additionalContext.slice(0, 90)}..."`
              : `json ${r.out.slice(0, 100)}`;
          } catch { shape = `plain text: "${r.out.slice(0, 100)}"`; }
        }
        console.log(`    ${ev}: exit ${r.status}; ${shape}${r.err ? `; stderr: ${r.err.slice(0, 150)}` : ''}`);
        if (r.status !== 0) warn(`${ev} hook exited ${r.status}`);
      }
    }

    // What each arm should look like
    const expectOn = armId !== 'none' && armId !== 'prism-toggle-off';
    if (expectOn && !block) warn('expected the PRISM block in CLAUDE.md');
    if (!expectOn && block) warn('expected no PRISM block in CLAUDE.md');

    if (setup.srcDir && armId.startsWith('prism-toggle')) {
      const s = prismStatus(setup.srcDir, home);
      console.log(`  prism-forge status: ${s}`);
      if ((armId === 'prism-toggle-on' && s !== 'on') || (armId === 'prism-toggle-off' && s !== 'off')) warn(`status '${s}' does not match the arm`);
      for (const d of setup.pluginDirs || []) {
        try {
          const c = resolveClaude();
          const r = spawnSync(c.cmd, [...c.pre, 'plugin', 'validate', d], { encoding: 'utf8', env: homeEnv(home), timeout: 60_000, windowsHide: true });
          console.log(`  claude plugin validate ${d.split(/[\\/]/).slice(-2).join('/')}: exit ${r.status}`);
          const text = ((r.stdout || '') + (r.stderr || '')).trim();
          if (text) console.log(text.split(/\r?\n/).slice(0, 12).map(l => `    | ${l}`).join('\n'));
          if (r.status !== 0) warn('plugin validate failed');
        } catch (e) { warn(`could not validate plugin: ${e.message}`); }
      }
    }
  } finally {
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    else console.log(`  (kept ${home})`);
  }
}

// --live: one tiny real session and one judge call, to prove credentials and
// output formats work before the pilot. Uses a little of your usage.
if (live && !problems) {
  console.log('\n# Live check (two small model calls)');
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'claude-sonnet-5-5';
  const home = mkdtempSync(join(tmpdir(), 'pfe-live-'));
  try {
    const turns = [{ text: 'Reply with exactly the word OK.' }];
    const s = await runSession({ home, cwd: home, model, args: ['--strict-mcp-config', '--tools', ''], turns, timeoutMs: 180_000 });
    const r = s.turnResults[0];
    const d = digest(s.events, turns);
    if (!r) warn(`session produced no result (exit ${s.exitCode}): ${s.stderr.slice(-500)}`);
    else if (r.is_error || r.subtype !== 'success') warn(`session error: ${r.subtype} ${String(r.result).slice(0, 300)}`);
    else console.log(`  session: ok; model ${d.model}; reply "${d.perTurn[0].text.slice(0, 40)}"; first request ${d.firstCtx} input tokens`);
    if (r && d.model && !String(d.model).startsWith(model)) warn(`served model ${d.model} differs from requested ${model}`);
  } catch (e) { warn(`session failed: ${e.message}`); }
  finally { rmSync(home, { recursive: true, force: true }); }
  if (st.judge !== false) {
    try {
      const usage = {};
      const c = { id: 'live', pairwise_focus: '' };
      const j = await judgePair({ model: st.judge_model || 'claude-opus-5-5', c, conversation: '[User, turn 1]\nWhat is 2 + 2?', candidate: '[Assistant, turn 1]\n4', reference: '[Assistant, turn 1]\n5', usage });
      console.log(`  judge (${JUDGE_BACKEND}): ok; preferred the correct answer: ${j.win === 1 ? 'yes' : `no (win=${j.win})`}; ${usage.input_tokens ?? '?'} input tokens`);
      if (j.win !== 1) warn('the judge did not prefer "4" over "5" in both orders; check the judge model before trusting grades');
    } catch (e) { warn(`judge call failed (${e.failure_class ?? 'error'}): ${e.message}`); }
  }
}

console.log(problems ? `\n${problems} problem(s) above. Fix them before a paid run.` : '\nPreflight clean.');
process.exit(problems ? 1 : 0);
