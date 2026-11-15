// Drive one Claude Code session headlessly: `claude -p` with stream-json in
// and out, one long-lived process for all of a case's turns. A single process
// matters: the prism-toggle mod keeps its "notice after a switch" in session
// state, which a fresh `claude -p --resume` per turn would lose.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homeEnv } from './arms.mjs';

const WIN = process.platform === 'win32';

// Find how to start Claude Code. CLAUDE_BIN overrides. On Windows an npm
// shim (claude.cmd) can't be spawned without a shell, so we run its cli.js
// with node instead.
export function resolveClaude() {
  const override = process.env.CLAUDE_BIN;
  let bin = override;
  if (!bin) {
    try {
      const out = execFileSync(WIN ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
      const lines = out.split(/\r?\n/).filter(Boolean);
      bin = (WIN && (lines.find(l => /\.exe$/i.test(l)) || lines.find(l => /\.cmd$/i.test(l)))) || lines[0];
    } catch {
      throw new Error('claude not found on PATH; set CLAUDE_BIN to the Claude Code executable');
    }
  }
  if (/\.(cmd|bat)$/i.test(bin)) {
    const cli = join(dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (!existsSync(cli)) throw new Error(`can't run ${bin} without a shell and found no ${cli}; set CLAUDE_BIN to claude.exe or cli.js`);
    return { cmd: process.execPath, pre: [cli] };
  }
  if (/\.(m?js)$/i.test(bin)) return { cmd: process.execPath, pre: [bin] };
  return { cmd: bin, pre: [] };
}

// Variables that make a child think it runs inside this Claude Code session
const NESTING_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID', 'CLAUDE_CODE_SSE_PORT',
];

export function sessionEnv(home) {
  const env = homeEnv(home);
  for (const k of NESTING_VARS) delete env[k];
  // With a subscription token present, runs bill to the subscription: drop the
  // API key from the child (Claude Code would otherwise prefer it). The judge,
  // in this process, still uses ANTHROPIC_API_KEY.
  // Blank lines in .env arrive as empty strings: drop those rather than pass them
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_BIN']) if (env[k] === '') delete env[k];
  if (env.CLAUDE_CODE_OAUTH_TOKEN) delete env.ANTHROPIC_API_KEY;
  return env;
}

/**
 * Run a session.
 * @param {object} o
 * @param {string} o.home       isolated HOME
 * @param {string} o.cwd        working directory (fresh per case)
 * @param {string} o.model      model id for the session
 * @param {string[]} o.args     extra CLI args (permissions, plugin dirs, ...)
 * @param {Array} o.turns       [{ text } | { control: 'slash', text } | { control: 'cli', command }]
 * @param {Function} o.onControl async (turn, index) => void; runs after a control turn
 * @param {number} o.timeoutMs  hard ceiling for the whole session
 * @param {string} [o.debugFile]
 * @returns {Promise<{events: object[], turnResults: object[], stderr: string, exitCode: number}>}
 */
export function runSession(o) {
  const { cmd, pre } = resolveClaude();
  const args = [
    ...pre, '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', o.model,
    ...(o.debugFile ? ['--debug-file', o.debugFile] : []),
    ...o.args,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: sessionEnv(o.home), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const events = [];
    const turnResults = [];
    let stderr = '';
    let buf = '';
    let turnIdx = -1;
    let settled = false;
    const finish = (fn) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };

    const timer = setTimeout(() => {
      child.kill();
      const e = new Error(`session exceeded ${o.timeoutMs / 1000}s`);
      e.failure_class = 'timeout';
      e.partial = { events, turnResults, stderr };
      finish(() => reject(e));
    }, o.timeoutMs);

    // Send the next turn the model should answer; control turns run here too
    const advance = async () => {
      for (;;) {
        turnIdx++;
        if (turnIdx >= o.turns.length) { child.stdin.end(); return; }
        const t = o.turns[turnIdx];
        if (t.control === 'cli') {
          // Harness-side toggle: nothing is sent to the model
          turnResults[turnIdx] = { control: true };
          await o.onControl?.(t, turnIdx);
          continue;
        }
        const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: t.text }] } };
        events.push({ type: '_sent', turn: turnIdx, text: t.text });
        child.stdin.write(JSON.stringify(msg) + '\n');
        return;
      }
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { events.push({ type: '_unparsed', line }); continue; }
        ev._turn = turnIdx;
        events.push(ev);
        if (ev.type === 'result') {
          turnResults[turnIdx] = ev;
          const t = o.turns[turnIdx];
          Promise.resolve(t?.control ? o.onControl?.(t, turnIdx) : null)
            .then(advance)
            .catch((e) => { child.kill(); finish(() => reject(e)); });
        }
      }
    });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); if (stderr.length > 200_000) stderr = stderr.slice(-200_000); });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => finish(() => resolve({ events, turnResults, stderr, exitCode: code })));

    advance().catch((e) => { child.kill(); finish(() => reject(e)); });
  });
}

// Split a session's events into per-turn assistant text, tool calls and usage
export function digest(events, turns) {
  const perTurn = turns.map((t) => ({ user: t.text ?? null, control: !!t.control, text: '', toolCalls: 0, tools: [] }));
  const seenMsg = new Map(); // assistant message id -> usage (stream repeats a message per block)
  let model = null;
  for (const ev of events) {
    if (ev.type === 'system' && ev.subtype === 'init' && ev.model) model = ev.model;
    if (ev.type !== 'assistant' || ev.parent_tool_use_id) continue; // skip subagent chatter
    const t = perTurn[ev._turn];
    const m = ev.message || {};
    if (m.model && !model) model = m.model;
    if (m.id && m.usage) seenMsg.set(m.id, { model: m.model, usage: m.usage, turn: ev._turn });
    for (const b of m.content || []) {
      if (!t) continue;
      if (b.type === 'text' && b.text) t.text += (t.text ? '\n\n' : '') + b.text;
      if (b.type === 'tool_use') { t.toolCalls++; t.tools.push(b.name); }
    }
  }
  const calls = [...seenMsg.values()];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const c of calls) for (const k of Object.keys(usage)) usage[k] += c.usage[k] || 0;
  const first = calls[0]?.usage;
  const firstCtx = first
    ? (first.input_tokens || 0) + (first.cache_read_input_tokens || 0) + (first.cache_creation_input_tokens || 0)
    : null;
  return { perTurn, usage, model, apiCalls: calls.length, firstCtx };
}

// Turn the raw events into the report's transcript shape
export function toTranscript(events) {
  const out = [];
  for (const ev of events) {
    if (ev.type === '_sent') out.push({ role: 'user', content: ev.text });
    else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text) out.push({ role: 'assistant', content: b.text });
        else if (b.type === 'tool_use') out.push({ role: 'tool_call', name: b.name, content: JSON.stringify(b.input ?? {}, null, 2) });
      }
    } else if (ev.type === 'user' && !ev.parent_tool_use_id) {
      for (const b of ev.message?.content || []) {
        if (b.type === 'tool_result') {
          const c = Array.isArray(b.content) ? b.content.map(x => x.text ?? '').join('\n') : String(b.content ?? '');
          out.push({ role: 'tool_result', content: c.length > 20_000 ? c.slice(0, 20_000) + '\n…[clipped]' : c });
        }
      }
    } else if (ev.type === 'system' && ev.subtype && ev.subtype !== 'init') {
      out.push({ role: 'system', content: `[${ev.subtype}] ${JSON.stringify(ev).slice(0, 2000)}` });
    }
  }
  return out;
}

export function readIfExists(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}
