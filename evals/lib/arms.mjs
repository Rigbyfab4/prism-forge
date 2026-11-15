// Arm definitions: how each variant's isolated Claude Code home is built.
//
// Every case runs in a brand-new temp folder used as HOME/USERPROFILE, so no
// arm sees your real ~/.claude (CLAUDE.md, settings, hooks, plugins, MCP
// servers). The only difference between arms is what setup() installs there.
//
// _state.json maps report variants (baseline, v1, v2, ...) to these arm ids.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT, materializeRef } from './source.mjs';

const WIN = process.platform === 'win32';

export function homeEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // A config dir override would point Claude Code back at the real config
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function runCli(srcDir, home, args) {
  return execFileSync(process.execPath, [join(srcDir, 'bin', 'prism-forge.js'), ...args], {
    env: homeEnv(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
  });
}

function writeJson(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

// Prism writes {"additionalContext": ...} at the top level of its
// UserPromptSubmit output. Claude Code ignores it; its debug log says so on
// every prompt ("Hook JSON output had unrecognized keys (ignored):
// additionalContext. Did you mean hookSpecificOutput.additionalContext?").
// The hookfix arms rewrite emit() to the documented shape.
const HOOK_FIX_FROM = 'sys.stdout.write(json.dumps({"additionalContext": directive}))';
const HOOK_FIX_TO =
  'sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": directive}}))';

function fixInjectHook(home) {
  const p = join(home, '.claude', 'hooks', 'prism_inject_routing.py');
  const src = readFileSync(p, 'utf8');
  if (!src.includes(HOOK_FIX_FROM)) {
    throw new Error(`hook fix: expected emit() line not found in ${p}; the hook changed, update evals/lib/arms.mjs`);
  }
  writeFileSync(p, src.replace(HOOK_FIX_FROM, HOOK_FIX_TO));
}

// The toggle mod calls `<node> <USERPROFILE>\<cliFromHome> status|enable|disable`.
// We copy the branch source into the temp home so that path resolves there.
const TOGGLE_SRC_DIR = 'prism-src';

function setupToggleBranch(home, ref) {
  const src = materializeRef(ref);
  const inHome = join(home, TOGGLE_SRC_DIR);
  cpSync(src, inHome, { recursive: true });
  runCli(inHome, home, ['install']);
  const modDir = join(inHome, 'mods', 'prism-toggle');
  if (!existsSync(join(modDir, '.claude-plugin', 'plugin.json'))) {
    throw new Error(`toggle arm: no mod at ${modDir} (ref ${ref})`);
  }
  // Plugin options live in settings.json pluginConfigs[<name>].options; an
  // inline (--plugin-dir) plugin may be keyed <name>@inline, so set both.
  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = readJson(settingsPath, {});
  const options = {
    node: process.execPath,
    // The mod joins this to the home folder with a backslash (Windows only)
    cliFromHome: `${TOGGLE_SRC_DIR}\\bin\\prism-forge.js`,
  };
  settings.pluginConfigs = {
    ...(settings.pluginConfigs || {}),
    'prism-toggle': { options },
    'prism-toggle@inline': { options },
  };
  writeJson(settingsPath, settings);
  return { srcDir: inHome, pluginDirs: [modDir] };
}

// The subagent council: three independent members, each a custom subagent in
// ~/.claude/agents/, and a CLAUDE.md rule for when to consult them. Same model
// as the main session (model: inherit), so only the setup differs.
const COUNCIL_AGENTS = {
  advocate: {
    description: 'Makes the strongest honest case FOR the most promising option, plan or idea. One of three independent council members (with critic and premortem) for decisions, plans and brainstorms.',
    prompt: `You are the advocate on a three-member council. The main assistant gives you a user's request and any context.

Make the strongest honest case for the most promising option (if there are several, rank them briefly and argue for the best one). Be concrete to this user's situation: the specific benefits, what must be true for it to work, and the cheapest way to check that before committing.

Don't invent facts; say what you would need to know. Stay under 250 words. Return only your case.`,
  },
  critic: {
    description: 'Makes the strongest honest case AGAINST the leading option, plan or idea: risks, hidden costs, simpler alternatives. One of three independent council members (with advocate and premortem).',
    prompt: `You are the critic on a three-member council. The main assistant gives you a user's request and any context.

Make the strongest honest case against the option the user is leaning toward, or the most obvious answer: concrete risks, hidden costs, and simpler or cheaper alternatives. End with the evidence that would change your mind.

Don't invent problems to have something to say; if the obvious answer is sound, say so and name its weakest point. Don't invent facts. Stay under 250 words. Return only your critique.`,
  },
  premortem: {
    description: 'Assumes the chosen approach failed 6-12 months from now and explains the most likely reasons, with early warning signs. One of three independent council members (with advocate and critic).',
    prompt: `You are the pre-mortem member of a three-member council. The main assistant gives you a user's request and any context.

Assume it is 6-12 months later and the most likely chosen approach has failed. List the three most plausible reasons it failed, most likely first. For each, give one early warning sign and one cheap way to prevent it.

Be specific to this situation, not generic. Don't invent facts. Stay under 250 words. Return only your pre-mortem.`,
  },
};

const COUNCIL_CLAUDE_MD = `# Council

For requests that call for a decision, a recommendation between options, a plan, or brainstorming, consult a council before answering: launch the advocate, critic and premortem subagents in parallel (one message with three Agent calls), each given the user's request and any relevant context. They work independently and don't see each other's output.

Then write one answer for the user: your recommendation, the strongest point from each member where it matters, where they disagree, and what evidence would settle it. Don't present the members as characters or quote them at length; the user wants a clear answer.

Answer directly, without the council, for factual questions, calculations, writing tasks, explanations, tutoring and coding tasks.
`;

function setupCouncil(home) {
  const agents = join(home, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  for (const [name, a] of Object.entries(COUNCIL_AGENTS)) {
    writeFileSync(join(agents, `${name}.md`),
      // JSON strings are valid YAML double-quoted scalars, so ': ' in a
      // description can't break the frontmatter
      `---\nname: ${name}\ndescription: ${JSON.stringify(a.description)}\ntools: Read, Grep, Glob\nmodel: inherit\n---\n\n${a.prompt}\n`);
  }
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), COUNCIL_CLAUDE_MD);
  // The subagent tool must be usable without a prompt in headless runs
  return { pluginDirs: [], allowedTools: ['Agent', 'Task'] };
}

export const ARMS = {
  none: {
    label: 'No Prism',
    description: 'Clean Claude Code: empty isolated home, no Prism files, hooks or mods.',
    setup(home) {
      mkdirSync(join(home, '.claude'), { recursive: true });
      return { pluginDirs: [] };
    },
  },

  'prism-main': {
    label: 'Prism (main, as shipped)',
    description: 'Prism from the main branch, installed with `prism-forge install` unchanged.',
    ref: 'main',
    setup(home, opts) {
      const src = materializeRef(opts.refs?.['prism-main'] ?? this.ref);
      runCli(src, home, ['install']);
      return { srcDir: src, pluginDirs: [] };
    },
  },

  'prism-main-hookfix': {
    label: 'Prism (main, hook fixed)',
    description:
      'Prism main with one change: the UserPromptSubmit hook emits hookSpecificOutput.additionalContext ' +
      '(the documented shape) instead of a top-level additionalContext. Answers "is Prism good when its ' +
      'routing directive actually reaches the model?"',
    ref: 'main',
    setup(home, opts) {
      const src = materializeRef(opts.refs?.['prism-main'] ?? this.ref);
      runCli(src, home, ['install']);
      fixInjectHook(home);
      return { srcDir: src, pluginDirs: [] };
    },
  },

  'prism-toggle-on': {
    label: 'Prism toggle branch, on',
    description:
      'Prism from feature/enable-disable (installs to ~/.claude/prism, adds disable/enable/status) with ' +
      'the prism-toggle mod loaded via --plugin-dir. Left enabled.',
    ref: 'origin/feature/enable-disable',
    setup(home, opts) {
      return setupToggleBranch(home, opts.refs?.['prism-toggle'] ?? this.ref);
    },
  },

  'prism-toggle-hookfix': {
    label: 'Prism toggle branch, on, hook fixed',
    description:
      'Toggle branch with the mod, enabled, plus the same one-line UserPromptSubmit fix as prism-main-hookfix. ' +
      'The branch no longer auto-loads persona files, so the per-message routing directive carries more weight ' +
      'there; this arm shows whether fixing its output shape changes behaviour.',
    ref: 'origin/feature/enable-disable',
    setup(home, opts) {
      const r = setupToggleBranch(home, opts.refs?.['prism-toggle'] ?? this.ref);
      fixInjectHook(home);
      return r;
    },
  },

  council: {
    label: 'Subagent council (no Prism)',
    description:
      'No Prism. Three custom subagents (advocate, critic, premortem) in ~/.claude/agents and a CLAUDE.md rule: ' +
      'consult them in parallel for decisions, plans and brainstorms, then synthesize; answer other requests directly.',
    setup(home) {
      return setupCouncil(home);
    },
  },

  'prism-toggle-off': {
    label: 'Prism toggle branch, off',
    description:
      'Same as "toggle branch, on", then `prism-forge disable` before the session starts. Should be ' +
      'indistinguishable from No Prism if "off" really means off.',
    ref: 'origin/feature/enable-disable',
    setup(home, opts) {
      const r = setupToggleBranch(home, opts.refs?.['prism-toggle'] ?? this.ref);
      runCli(r.srcDir, home, ['disable']);
      return r;
    },
  },
};

export function getArm(id) {
  const arm = ARMS[id];
  if (!arm) throw new Error(`unknown arm '${id}' (known: ${Object.keys(ARMS).join(', ')})`);
  return arm;
}

// Run a prism-forge CLI command inside an arm's home (used by toggle cases)
export function prismCli(srcDir, home, command) {
  try {
    return { ok: true, out: runCli(srcDir, home, [command]) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || e.message) };
  }
}

export function prismStatus(srcDir, home) {
  const r = prismCli(srcDir, home, 'status');
  if (r.out.startsWith('PRISM is enabled')) return 'on';
  if (r.out.startsWith('PRISM is disabled')) return 'off';
  if (r.out.includes('not installed')) return 'missing';
  return 'unknown';
}

export { REPO_ROOT, WIN, resolve };
