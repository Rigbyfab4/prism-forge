#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json`
// used only to test the harness plumbing for free. It speaks the same event
// shapes the runner reads, behaves "Prism-like" when the isolated home has an
// enabled Prism install, and emulates the prism-toggle mod's /prism command
// by calling the CLI the way the mod does.
//
//   CLAUDE_BIN=test/fake-claude.mjs EVAL_JUDGE=mock node run-eval.mjs ...

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1] || 'claude-sonnet-5-5';
const home = process.env.HOME;
const session = `fake-${process.pid}`;
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const prismOn = () => {
  const md = join(home, '.claude', 'CLAUDE.md');
  return existsSync(md) && readFileSync(md, 'utf8').includes('PRISM:START');
};
let modNotice = null;
let n = 0;

// Judge-style one-shot call: `claude -p --output-format json --json-schema ...`
if (args.includes('--json-schema')) {
  let input = '';
  process.stdin.on('data', c => { input += c; });
  process.stdin.on('end', () => {
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
    // Mirror the real CLI, which rejects the 2020-12 meta-schema
    if (String(schema.$schema || '').includes('2020-12')) {
      process.stderr.write(`Error: --json-schema is not a valid JSON Schema: no schema with key or ref "${schema.$schema}"\n`);
      process.exit(1);
    }
    let out;
    if (schema.properties?.winner) out = { reasoning: 'fake judge', winner: 'tie' };
    else {
      const ids = [...input.matchAll(/^- ([\w-]+): /gm)].map(m => m[1]);
      out = { criteria: ids.map((id, i) => ({ id, met: i % 2 === 0, reason: 'fake judge' })) };
    }
    const usage = { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(out), structured_output: out, usage, modelUsage: { [model]: {} } }) + '\n');
  });
} else {
emit({ type: 'system', subtype: 'init', session_id: session, model, tools: ['Read', 'Edit'] });

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const text = msg.message.content.map(b => b.text).join('');
  n++;
  let reply;
  const toggle = /^\/prism (on|off)\s*$/.exec(text.trim());
  if (toggle) {
    const cli = join(home, 'prism-src', 'bin', 'prism-forge.js');
    if (existsSync(cli) && !process.env.FAKE_IGNORE_SLASH) execFileSync(process.execPath, [cli, toggle[1] === 'on' ? 'enable' : 'disable'], { env: process.env, stdio: 'ignore' });
    modNotice = toggle[1];
    reply = `PRISM turned ${toggle[1]}.`;
  } else {
    const tag = prismOn() ? '**Susie (Chief of Staff):**\n' : '';
    reply = `${tag}Here is a fake answer to: ${text.slice(0, 60)}. 17% of 2,340 is 397.8.`;
    modNotice = null;
  }
  const id = `msg_${n}`;
  const usage = { input_tokens: 10, cache_creation_input_tokens: prismOn() ? 40000 : 12000, cache_read_input_tokens: 0, output_tokens: 50 };
  emit({ type: 'assistant', session_id: session, parent_tool_use_id: null, message: { id, model, role: 'assistant', content: [{ type: 'text', text: reply }], usage } });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: reply, num_turns: 1, total_cost_usd: 0.01 * n, usage });
});
rl.on('close', () => process.exit(0));
}
