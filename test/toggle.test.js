import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getStashDir, getFlagPath, readDisabledState, disablePrism, enablePrism } from '../lib/toggle.js';
import { injectBlock, START_DELIMITER } from '../lib/claude-md.js';
import { runVerify } from '../lib/verify.js';
import { runInstall } from '../lib/install.js';
import { runUninstall } from '../lib/uninstall.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_SRC = resolve(__dirname, '..', 'src', 'hooks');

// Every path PRISM uses comes from os.homedir(), so point it at a temp folder
let home;
const saved = {};
function useTempHome() {
  home = mkdtempSync(join(tmpdir(), 'prism-toggle-'));
  for (const key of ['HOME', 'USERPROFILE']) {
    saved[key] = process.env[key];
    process.env[key] = home;
  }
}
function restoreHome() {
  for (const key of ['HOME', 'USERPROFILE']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(home, { recursive: true, force: true });
}

const rulesDir = () => join(home, '.claude', 'rules', 'prism');
const stashDir = () => join(home, '.claude', 'prism-disabled', 'prism');
const claudeMd = () => join(home, '.claude', 'CLAUDE.md');

// A minimal install: manifest, one persona file, and the CLAUDE.md block next to user content
async function fakeInstall(targetDir = rulesDir()) {
  mkdirSync(join(targetDir, 'personas'), { recursive: true });
  writeFileSync(join(targetDir, 'prism-manifest.json'), '{"version":"2.0","files":{}}\n');
  writeFileSync(join(targetDir, 'personas', 'persona-analyst-mary.md'), '# Mary\n');
  mkdirSync(dirname(claudeMd()), { recursive: true });
  writeFileSync(claudeMd(),'# My own instructions\n\nAlways use tabs.\n');
  await injectBlock(targetDir);
}

function mdFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).filter(f => String(f).endsWith('.md'));
}

describe('toggle', () => {
  beforeEach(useTempHome);
  afterEach(restoreHome);

  describe('getStashDir', () => {
    it('moves installs under .claude/rules/ to .claude/prism-disabled/', () => {
      assert.equal(getStashDir(join(home, '.claude', 'rules', 'prism')), join(home, '.claude', 'prism-disabled', 'prism'));
      assert.equal(
        getStashDir(join(home, 'project', '.claude', 'rules', 'team', 'prism')),
        join(home, 'project', '.claude', 'prism-disabled', 'team', 'prism'),
      );
    });

    it('returns null for installs outside .claude/rules/', () => {
      assert.equal(getStashDir(join(home, 'somewhere', 'prism')), null);
    });
  });

  describe('disablePrism', () => {
    it('leaves nothing for Claude Code to load: flag set, block removed, files moved out of rules/', async () => {
      await fakeInstall();
      const { changed, state } = await disablePrism();

      assert.equal(changed, true);
      assert.ok(existsSync(getFlagPath()), 'flag next to the hooks');
      assert.equal(state.target_dir, resolve(rulesDir()));
      assert.equal(state.stash_dir, stashDir());

      const md = readFileSync(claudeMd(), 'utf-8');
      assert.ok(!md.includes(START_DELIMITER), 'PRISM block removed');
      assert.match(md, /Always use tabs\./, 'user content kept');

      assert.deepEqual(mdFilesUnder(join(home, '.claude', 'rules')), [], 'no .md left under rules/');
      assert.equal(readFileSync(join(stashDir(), 'personas', 'persona-analyst-mary.md'), 'utf-8'), '# Mary\n');
    });

    it('is a no-op when already disabled', async () => {
      await fakeInstall();
      await disablePrism();
      const { changed } = await disablePrism();
      assert.equal(changed, false);
    });

    it('throws and changes nothing when PRISM is not installed', async () => {
      await assert.rejects(disablePrism(), /No PRISM installation found/);
      assert.equal(existsSync(getFlagPath()), false);
    });

    it('throws and changes nothing when the stash location is already taken', async () => {
      await fakeInstall();
      mkdirSync(stashDir(), { recursive: true });
      const before = readFileSync(claudeMd(), 'utf-8');

      await assert.rejects(disablePrism(), /already exists/);
      assert.equal(existsSync(getFlagPath()), false);
      assert.equal(readFileSync(claudeMd(), 'utf-8'), before);
      assert.ok(existsSync(join(rulesDir(), 'prism-manifest.json')));
    });

    it('leaves a custom install outside rules/ in place but still removes the block', async () => {
      const custom = join(home, 'tools', 'prism');
      await fakeInstall(custom);
      const { state } = await disablePrism({ path: custom });

      assert.equal(state.stash_dir, null);
      assert.ok(existsSync(join(custom, 'prism-manifest.json')));
      assert.ok(!readFileSync(claudeMd(), 'utf-8').includes(START_DELIMITER));
    });
  });

  describe('enablePrism', () => {
    it('restores files, block and hooks exactly as they were', async () => {
      await fakeInstall();
      const mdBefore = readFileSync(claudeMd(), 'utf-8');
      await disablePrism();
      const { changed } = await enablePrism();

      assert.equal(changed, true);
      assert.equal(existsSync(getFlagPath()), false);
      assert.equal(existsSync(stashDir()), false);
      assert.equal(existsSync(join(home, '.claude', 'prism-disabled')), false, 'empty stash folder removed');
      assert.equal(readFileSync(join(rulesDir(), 'personas', 'persona-analyst-mary.md'), 'utf-8'), '# Mary\n');
      assert.equal(readFileSync(claudeMd(), 'utf-8'), mdBefore);
    });

    it('is a no-op when already enabled', async () => {
      await fakeInstall();
      const { changed } = await enablePrism();
      assert.equal(changed, false);
    });

    it('refuses to overwrite a new install at the original location', async () => {
      await fakeInstall();
      await disablePrism();
      mkdirSync(rulesDir(), { recursive: true });

      await assert.rejects(enablePrism(), /Both .* exist/);
      assert.ok(readDisabledState(), 'still disabled');
      assert.ok(existsSync(stashDir()), 'stash untouched');
    });
  });

  describe('verify', () => {
    it('reports disabled instead of failing', async () => {
      await fakeInstall();
      await disablePrism();
      const result = await runVerify(undefined, { quiet: true });
      assert.equal(result.disabled, true);
      assert.equal(result.failed, 0);
    });
  });

  describe('install and uninstall while disabled', () => {
    it('install re-enables, and uninstall removes everything including the flag and stash', async () => {
      await runInstall();
      await disablePrism();

      await runInstall();
      assert.equal(readDisabledState(), null, 'install re-enabled PRISM');
      assert.equal(existsSync(stashDir()), false);
      assert.ok(readFileSync(claudeMd(), 'utf-8').includes(START_DELIMITER));

      await disablePrism();
      await runUninstall();
      assert.equal(readDisabledState(), null, 'flag removed');
      assert.equal(existsSync(stashDir()), false, 'stash removed');
      assert.deepEqual(mdFilesUnder(join(home, '.claude', 'rules')), []);
      assert.ok(!readFileSync(claudeMd(), 'utf-8').includes(START_DELIMITER));
    });
  });

  describe('hooks', () => {
    // Run a copy of each hook from a temp hooks dir, with and without the flag next to it
    function runHook(file, input, { disabled }) {
      const dir = join(home, '.claude', 'hooks');
      mkdirSync(dir, { recursive: true });
      for (const f of readdirSync(HOOKS_SRC)) copyFileSync(join(HOOKS_SRC, f), join(dir, f));
      const flag = join(dir, '.prism-disabled');
      if (disabled) writeFileSync(flag, '{}\n');
      else rmSync(flag, { force: true });

      const cmd = file.endsWith('.py') ? 'python' : 'bash';
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      return spawnSync(cmd, [join(dir, file)], { input: JSON.stringify(input), encoding: 'utf-8', env });
    }

    const cases = [
      ['prism_session_start.sh', { hook_event_name: 'SessionStart' }],
      ['prism_inject_routing.sh', { prompt: 'audit everything', cwd: '.' }],
      ['prism_inject_routing.py', { prompt: 'audit everything', cwd: '.' }],
    ];

    for (const [file, input] of cases) {
      it(`${file} prints nothing when disabled and still works when enabled`, () => {
        const off = runHook(file, input, { disabled: true });
        assert.equal(off.status, 0, off.stderr);
        assert.equal(off.stdout, '');

        const on = runHook(file, input, { disabled: false });
        assert.equal(on.status, 0, on.stderr);
        assert.match(on.stdout, /additionalContext/);
      });
    }

    it('prism_check_attribution.py logs nothing when disabled', () => {
      const transcript = join(home, 'transcript.jsonl');
      writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: 'ok' } }) + '\n');
      const input = { transcript_path: transcript, session_id: 's', hook_event_name: 'Stop' };
      const log = join(home, '.claude', 'hooks', 'prism_routing_events.jsonl');

      const off = runHook('prism_check_attribution.py', input, { disabled: true });
      assert.equal(off.status, 0, off.stderr);
      assert.equal(off.stdout, '');
      assert.equal(existsSync(log), false, 'no drift event logged');

      const on = runHook('prism_check_attribution.py', input, { disabled: false });
      assert.equal(on.status, 0, on.stderr);
      assert.ok(existsSync(log), 'event logged when enabled');
    });
  });
});
