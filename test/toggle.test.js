import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync, utimesSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getFlagPath, readDisabledState, disablePrism, enablePrism, withLock, runStatus } from '../lib/toggle.js';
import { injectBlock, removeBlock, START_DELIMITER } from '../lib/claude-md.js';
import { runVerify } from '../lib/verify.js';
import { runInstall } from '../lib/install.js';
import { runUninstall } from '../lib/uninstall.js';
import { hashString } from '../lib/hash.js';
import { migrateLegacyInstall, moveInstall, verifyCopy } from '../lib/migrate-location.js';

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

const installDir = () => join(home, '.claude', 'prism');
const legacyRulesDir = () => join(home, '.claude', 'rules', 'prism');
const legacyStashDir = () => join(home, '.claude', 'prism-disabled', 'prism');
const claudeMd = () => join(home, '.claude', 'CLAUDE.md');
const lockPath = () => join(home, '.claude', 'hooks', '.prism-toggle.lock');

// A minimal install: manifest, one persona file, and the CLAUDE.md block next to user content
async function fakeInstall(targetDir = installDir()) {
  mkdirSync(join(targetDir, 'personas'), { recursive: true });
  writeFileSync(join(targetDir, 'prism-manifest.json'), '{"version":"2.0","files":{}}\n');
  writeFileSync(join(targetDir, 'personas', 'persona-analyst-mary.md'), '# Mary\n');
  mkdirSync(dirname(claudeMd()), { recursive: true });
  writeFileSync(claudeMd(), '# My own instructions\n\nAlways use tabs.\n');
  await injectBlock(targetDir);
}

function mdFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).filter(f => String(f).endsWith('.md'));
}

// Every file under dir, relative path -> contents (for byte-identical comparisons)
function snapshot(dir) {
  const out = {};
  for (const rel of readdirSync(dir, { recursive: true })) {
    const full = join(dir, String(rel));
    if (readdirSyncSafe(full) === null) out[String(rel)] = readFileSync(full).toString('base64');
  }
  return out;
}
function readdirSyncSafe(p) {
  try { return readdirSync(p); } catch { return null; }
}

function countBlocks(text) {
  return text.split(START_DELIMITER).length - 1;
}

// Silence and capture console.log while fn runs
async function captureLog(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error, exit: process.exit };
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  // run* commands call process.exit(1) on failure; surface that as a test failure instead
  process.exit = (code) => { throw new Error(`process.exit(${code}) called:\n${lines.join('\n')}`); };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    process.exit = orig.exit;
  }
}

// A faithful pre-relocation install: really install, but into the old location
// Files of that era said ~/.claude/rules/prism wherever they lived, so rewrite the paths
// and re-record the hashes (otherwise the files would look user-modified).
async function legacyInstallAt(dir) {
  await captureLog(() => runInstall({ path: dir }));
  const manifestPath = join(dir, 'prism-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  for (const rel of Object.keys(manifest.files)) {
    const full = join(dir, rel);
    const text = readFileSync(full, 'utf-8')
      .replace(/~\/\.claude\/(?:prism-disabled\/prism|rules\/prism|prism)/g, '~/.claude/rules/prism');
    writeFileSync(full, text);
    manifest.files[rel] = { hash: hashString(text) };
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

describe('toggle', () => {
  beforeEach(useTempHome);
  afterEach(restoreHome);

  describe('disablePrism', () => {
    it('leaves the install in place, byte-identical: flag set, block removed, user content kept', async () => {
      await fakeInstall();
      const before = snapshot(installDir());
      const { changed, state } = await disablePrism();

      assert.equal(changed, true);
      assert.ok(existsSync(getFlagPath()), 'flag next to the hooks');
      assert.equal(state.target_dir, resolve(installDir()));
      assert.deepEqual(snapshot(installDir()), before, 'install directory untouched');

      // The flag records only when PRISM was disabled; it is never trusted for paths
      const flag = JSON.parse(readFileSync(getFlagPath(), 'utf-8'));
      assert.deepEqual(Object.keys(flag), ['disabled_at']);
      assert.ok(!Number.isNaN(Date.parse(flag.disabled_at)));

      const md = readFileSync(claudeMd(), 'utf-8');
      assert.ok(!md.includes(START_DELIMITER), 'PRISM block removed');
      assert.match(md, /Always use tabs\./, 'user content kept');
      assert.equal(existsSync(lockPath()), false, 'lock released');
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
      assert.equal(existsSync(lockPath()), false, 'lock released after a failure');
    });

    it('leaves a custom install in place and removes the block', async () => {
      const custom = join(home, 'tools', 'prism');
      await fakeInstall(custom);
      const { state } = await disablePrism({ path: custom });

      assert.equal(state.target_dir, resolve(custom));
      assert.ok(existsSync(join(custom, 'prism-manifest.json')));
      assert.ok(!readFileSync(claudeMd(), 'utf-8').includes(START_DELIMITER));
    });

    it('after a real install, no PRISM .md is left under ~/.claude/rules/ and the install stays put', async () => {
      await captureLog(() => runInstall());
      await disablePrism();

      assert.deepEqual(mdFilesUnder(join(home, '.claude', 'rules')), [], 'nothing for Claude Code to auto-load');
      assert.ok(existsSync(join(installDir(), 'prism-manifest.json')), 'install still at ~/.claude/prism');
      assert.ok(mdFilesUnder(installDir()).length > 20, 'persona files still there');

      // Token paths in the installed files point at the new default, never the old one
      const manifest = JSON.parse(readFileSync(join(installDir(), 'prism-manifest.json'), 'utf-8'));
      let sawNewPath = false;
      for (const rel of Object.keys(manifest.files)) {
        const text = readFileSync(join(installDir(), rel), 'utf-8');
        assert.ok(!text.includes('rules/prism'), `${rel} still mentions rules/prism`);
        if (text.includes('~/.claude/prism/')) sawNewPath = true;
      }
      assert.ok(sawNewPath, 'installed files reference ~/.claude/prism/');
    });

    it('rolls back (removes the flag it created) when the CLAUDE.md edit fails', async () => {
      await fakeInstall();
      const before = readFileSync(claudeMd(), 'utf-8');

      // Portable failure injection: make every write/rename that targets CLAUDE.md throw.
      // claude-md.js imports these by name from node:fs/promises; mutating the module
      // object and calling syncBuiltinESMExports() updates those live bindings.
      const orig = { writeFile: fsp.writeFile, rename: fsp.rename };
      const guard = (fn) => async (...args) => {
        if (String(args[0]).includes('CLAUDE.md') || String(args[1]).includes('CLAUDE.md')) {
          throw Object.assign(new Error('injected failure'), { code: 'EPERM' });
        }
        return fn(...args);
      };
      fsp.writeFile = guard(orig.writeFile);
      fsp.rename = guard(orig.rename);
      syncBuiltinESMExports();
      try {
        await assert.rejects(disablePrism(), /Could not disable PRISM .*PRISM is still enabled/);
      } finally {
        fsp.writeFile = orig.writeFile;
        fsp.rename = orig.rename;
        syncBuiltinESMExports();
      }

      assert.equal(existsSync(getFlagPath()), false, 'flag created by this call removed');
      assert.equal(readFileSync(claudeMd(), 'utf-8'), before, 'CLAUDE.md untouched');
      assert.ok(existsSync(join(installDir(), 'prism-manifest.json')));
      assert.equal(existsSync(lockPath()), false);
    });

    it('never touches a flag it did not create', async () => {
      await fakeInstall();
      // Simulates another process that disabled PRISM first
      const original = '{\n  "disabled_at": "2020-01-01T00:00:00.000Z"\n}\n';
      mkdirSync(dirname(getFlagPath()), { recursive: true });
      writeFileSync(getFlagPath(), original);

      const { changed } = await disablePrism();
      assert.equal(changed, false);
      assert.equal(readFileSync(getFlagPath(), 'utf-8'), original);
      assert.ok(readFileSync(claudeMd(), 'utf-8').includes(START_DELIMITER), 'block not touched either');
    });

    it('serializes concurrent disables: exactly one changes anything', async () => {
      await fakeInstall();
      const before = snapshot(installDir());
      const results = await Promise.all([disablePrism(), disablePrism()]);

      assert.equal(results.filter(r => r.changed).length, 1);
      assert.ok(existsSync(getFlagPath()));
      const md = readFileSync(claudeMd(), 'utf-8');
      assert.equal(countBlocks(md), 0, 'block removed');
      assert.match(md, /Always use tabs\./);
      assert.deepEqual(snapshot(installDir()), before);
      assert.equal(existsSync(lockPath()), false, 'lock released');
    });

    it('concurrent disable + enable finish in a consistent state', async () => {
      await fakeInstall();
      const outcomes = await Promise.allSettled([disablePrism(), enablePrism()]);
      for (const o of outcomes) {
        if (o.status === 'rejected') assert.match(o.reason.message, /in progress/, o.reason.message);
      }
      const md = readFileSync(claudeMd(), 'utf-8');
      assert.equal(existsSync(getFlagPath()), countBlocks(md) === 0, 'flag present <=> block absent');
      assert.ok(countBlocks(md) <= 1);
      assert.match(md, /Always use tabs\./);
      assert.equal(existsSync(lockPath()), false, 'lock released');
    });
  });

  describe('enablePrism', () => {
    it('restores the block exactly once, clears the flag, and round-trips CLAUDE.md', async () => {
      await fakeInstall();
      const mdBefore = readFileSync(claudeMd(), 'utf-8');
      const filesBefore = snapshot(installDir());
      await disablePrism();
      const { changed } = await enablePrism();

      assert.equal(changed, true);
      assert.equal(existsSync(getFlagPath()), false);
      const md = readFileSync(claudeMd(), 'utf-8');
      assert.equal(countBlocks(md), 1, 'block present exactly once');
      assert.match(md, /# My own instructions\n\nAlways use tabs\./, 'user content intact');
      assert.equal(md, mdBefore, 'CLAUDE.md byte-identical after disable + enable');
      assert.deepEqual(snapshot(installDir()), filesBefore);
      assert.equal(existsSync(lockPath()), false);
    });

    it('is a no-op when already enabled', async () => {
      await fakeInstall();
      const { changed } = await enablePrism();
      assert.equal(changed, false);
    });

    it('enables a custom install with { path }', async () => {
      const custom = join(home, 'tools', 'prism');
      await fakeInstall(custom);
      await disablePrism({ path: custom });
      await enablePrism({ path: custom });
      const md = readFileSync(claudeMd(), 'utf-8');
      assert.equal(countBlocks(md), 1);
      assert.equal(readDisabledState(), null);
    });

    it('ignores a hostile flag: paths in it are never read, moved or touched', async () => {
      await fakeInstall();
      await removeBlock(); // as if it had been disabled
      const elsewhere = join(home, 'elsewhere');
      mkdirSync(join(elsewhere, 'personas'), { recursive: true });
      writeFileSync(join(elsewhere, 'prism-manifest.json'), '{"version":"2.0","files":{}}\n');
      writeFileSync(join(elsewhere, 'personas', 'keep.md'), 'precious\n');
      const stash = join(home, 'stash-elsewhere');
      mkdirSync(stash, { recursive: true });
      writeFileSync(join(stash, 'keep.txt'), 'also precious\n');
      mkdirSync(dirname(getFlagPath()), { recursive: true });
      writeFileSync(getFlagPath(), JSON.stringify({ target_dir: elsewhere, stash_dir: stash }));
      const elsewhereBefore = snapshot(elsewhere);
      const stashBefore = snapshot(stash);

      const { changed } = await enablePrism();
      assert.equal(changed, true);

      const md = readFileSync(claudeMd(), 'utf-8');
      assert.equal(countBlocks(md), 1);
      assert.ok(md.includes('~/.claude/prism/routing/routing-engine.md'), 'block points at the recomputed default target');
      assert.equal(existsSync(getFlagPath()), false);
      assert.deepEqual(snapshot(elsewhere), elsewhereBefore, 'flag target_dir untouched');
      assert.deepEqual(snapshot(stash), stashBefore, 'flag stash_dir untouched');
      assert.ok(existsSync(join(installDir(), 'prism-manifest.json')), 'default install untouched');
    });

    it('refuses to enable over a legacy stash and changes nothing', async () => {
      await legacyInstallAt(legacyStashDir());
      await removeBlock();
      mkdirSync(dirname(getFlagPath()), { recursive: true });
      const flagText = JSON.stringify({ disabled_at: '2020-01-01T00:00:00.000Z', target_dir: legacyRulesDir(), stash_dir: legacyStashDir() });
      writeFileSync(getFlagPath(), flagText);
      const before = snapshot(legacyStashDir());

      await assert.rejects(enablePrism(), /disabled by an older version.*npx prism-forge install/s);
      assert.equal(readFileSync(getFlagPath(), 'utf-8'), flagText, 'flag untouched');
      assert.deepEqual(snapshot(legacyStashDir()), before, 'stash untouched');
      assert.equal(existsSync(installDir()), false, 'nothing created at the new default');
      assert.equal(countBlocks(readFileSync(claudeMd(), 'utf-8')), 0);
      assert.equal(existsSync(lockPath()), false);
    });
  });

  describe('withLock', () => {
    it('takes over a stale lock', async () => {
      mkdirSync(dirname(lockPath()), { recursive: true });
      writeFileSync(lockPath(), '{"pid":1}');
      const old = new Date(Date.now() - 10 * 60 * 1000);
      utimesSync(lockPath(), old, old);

      let ran = false;
      await withLock(() => { ran = true; }, { timeoutMs: 500, staleMs: 60000 });
      assert.ok(ran);
      assert.equal(existsSync(lockPath()), false);
    });

    it('throws "in progress" for a fresh foreign lock, and leaves it alone', async () => {
      mkdirSync(dirname(lockPath()), { recursive: true });
      writeFileSync(lockPath(), 'foreign');
      let ran = false;
      await assert.rejects(
        withLock(() => { ran = true; }, { timeoutMs: 150, staleMs: 60000 }),
        /Another PRISM disable\/enable is in progress/,
      );
      assert.equal(ran, false);
      assert.equal(readFileSync(lockPath(), 'utf-8'), 'foreign', 'lock we did not create is not unlinked');
    });

    it('releases the lock when fn throws, and passes the error through', async () => {
      await assert.rejects(withLock(() => { throw new Error('boom'); }), /boom/);
      assert.equal(existsSync(lockPath()), false);
      await withLock(() => {}, { timeoutMs: 200 }); // reacquirable
    });

    it('returns fn\'s value', async () => {
      assert.equal(await withLock(async () => 42), 42);
    });

    it('does not unlink a lock someone else took over meanwhile', async () => {
      await withLock(() => {
        rmSync(lockPath(), { force: true });
        writeFileSync(lockPath(), 'someone-else');
      });
      assert.equal(readFileSync(lockPath(), 'utf-8'), 'someone-else');
    });
  });

  describe('migration to ~/.claude/prism', () => {
    it('moves ~/.claude/rules/prism, then install rewrites tokens and backs up user edits', async () => {
      await legacyInstallAt(legacyRulesDir());
      assert.ok(readFileSync(join(legacyRulesDir(), 'routing', 'routing-engine.md'), 'utf-8').includes('~/.claude/rules/prism'),
        'fixture really is a legacy install');
      const edited = join(legacyRulesDir(), 'personas', 'persona-dev-amelia.md');
      writeFileSync(edited, readFileSync(edited, 'utf-8') + '\nMy own tweak about ~/.claude/rules/prism.\n');

      const res = await migrateLegacyInstall();
      assert.equal(res.migrated, true);
      assert.equal(res.from, legacyRulesDir());
      assert.equal(res.to, installDir());
      assert.equal(existsSync(legacyRulesDir()), false, 'old dir gone');
      assert.ok(existsSync(join(installDir(), 'prism-manifest.json')));

      const { lines } = await captureLog(() => runInstall());
      assert.ok(lines.some(l => /Existing installation detected/.test(l)));

      const manifest = JSON.parse(readFileSync(join(installDir(), 'prism-manifest.json'), 'utf-8'));
      assert.equal(manifest.version, '2.0');
      for (const rel of Object.keys(manifest.files)) {
        assert.ok(!readFileSync(join(installDir(), rel), 'utf-8').includes('rules/prism'), `${rel} still mentions rules/prism`);
      }
      assert.ok(!readFileSync(claudeMd(), 'utf-8').includes('rules/prism'), 'CLAUDE.md block points at the new path');
      assert.deepEqual(mdFilesUnder(join(home, '.claude', 'rules')), []);

      const backups = mdFilesUnder(join(installDir(), '.prism-backup'));
      assert.ok(backups.some(f => String(f).endsWith('persona-dev-amelia.md')), 'user-modified file kept in .prism-backup');
    });

    it('runInstall does the whole migration from the legacy rules dir by itself', async () => {
      await legacyInstallAt(legacyRulesDir());
      const { lines } = await captureLog(() => runInstall());
      assert.ok(lines.some(l => /Migrated legacy install: ~\/\.claude\/rules\/prism -> ~\/\.claude\/prism/.test(l)), lines.join('\n'));
      assert.equal(existsSync(legacyRulesDir()), false);
      assert.ok(existsSync(join(installDir(), 'prism-manifest.json')));
    });

    it('install migrates a legacy stash, clears the old flag and leaves PRISM enabled', async () => {
      await legacyInstallAt(legacyStashDir());
      // As the previous version's disable left things: block gone, flag with old paths
      await removeBlock();
      mkdirSync(dirname(getFlagPath()), { recursive: true });
      writeFileSync(getFlagPath(), JSON.stringify({
        disabled_at: '2020-01-01T00:00:00.000Z', target_dir: legacyRulesDir(), stash_dir: legacyStashDir(),
      }));

      await captureLog(() => runInstall());
      assert.equal(readDisabledState(), null, 'flag cleared');
      assert.equal(existsSync(legacyStashDir()), false, 'stash gone');
      assert.equal(existsSync(join(home, '.claude', 'prism-disabled')), false, 'empty stash folder removed');
      assert.ok(existsSync(join(installDir(), 'prism-manifest.json')));
      assert.equal(countBlocks(readFileSync(claudeMd(), 'utf-8')), 1, 'PRISM enabled with its block');
      assert.ok(!readFileSync(claudeMd(), 'utf-8').includes('rules/prism'));
      assert.equal(existsSync(lockPath()), false);
    });

    it('does nothing when the new default already has an install', async () => {
      await fakeInstall();
      mkdirSync(join(legacyRulesDir(), 'personas'), { recursive: true });
      writeFileSync(join(legacyRulesDir(), 'prism-manifest.json'), '{"version":"2.0","files":{}}\n');
      writeFileSync(join(legacyRulesDir(), 'personas', 'old.md'), 'old\n');
      const newBefore = snapshot(installDir());
      const oldBefore = snapshot(legacyRulesDir());

      const res = await migrateLegacyInstall();
      assert.equal(res.migrated, false);
      assert.equal(res.reason, 'target_exists');
      assert.deepEqual(res.leftovers, [legacyRulesDir()]);
      assert.deepEqual(snapshot(installDir()), newBefore);
      assert.deepEqual(snapshot(legacyRulesDir()), oldBefore);
    });

    it('reports reason "none" when there is nothing to migrate', async () => {
      assert.deepEqual(await migrateLegacyInstall(), { migrated: false, reason: 'none' });
    });

    describe('copy fallback (rename refused)', () => {
      // Make renameSync(src, ...) fail with EXDEV for one specific source, so the
      // copy -> verify -> rename -> delete path runs on any platform.
      let origRename;
      function refuseRenameOf(src) {
        origRename = fs.renameSync;
        fs.renameSync = (from, to) => {
          if (from === src) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
          return origRename(from, to);
        };
        syncBuiltinESMExports();
      }
      afterEach(() => {
        if (origRename) fs.renameSync = origRename;
        origRename = undefined;
        syncBuiltinESMExports();
      });

      function fixture() {
        const src = legacyRulesDir();
        mkdirSync(join(src, 'personas'), { recursive: true });
        writeFileSync(join(src, 'prism-manifest.json'), '{"version":"2.0","files":{}}\n');
        writeFileSync(join(src, 'personas', 'persona-a.md'), 'alpha\n');
        return src;
      }

      it('copies, verifies, renames into place, then removes the source', async () => {
        const src = fixture();
        const before = snapshot(src);
        refuseRenameOf(src);

        const res = await migrateLegacyInstall();
        assert.equal(res.migrated, true);
        assert.equal(res.warning, undefined);
        assert.equal(existsSync(src), false);
        assert.deepEqual(snapshot(installDir()), before);
        assert.deepEqual(readdirSync(dirname(installDir())).filter(n => n.includes('migrating')), [], 'no temp dir left');
      });

      it('a failed copy leaves the source intact and no temp dir behind', async () => {
        const src = fixture();
        const before = snapshot(src);
        refuseRenameOf(src);

        const failingCopy = (from, to) => {
          mkdirSync(to, { recursive: true });
          writeFileSync(join(to, 'partial.md'), 'half'); // partial state
          throw new Error('disk full');
        };
        await assert.rejects(
          migrateLegacyInstall({ copyFn: failingCopy }),
          /Could not migrate .* \(disk full\)\. The old install was left in place\./,
        );
        assert.deepEqual(snapshot(src), before, 'source untouched');
        assert.equal(existsSync(installDir()), false, 'nothing at the destination');
        assert.deepEqual(readdirSync(dirname(installDir())).filter(n => n.includes('migrating')), [], 'temp copy cleaned up');
      });

      it('a copy that does not match the source is rejected, source kept', async () => {
        const src = fixture();
        const before = snapshot(src);
        refuseRenameOf(src);

        const corruptCopy = (from, to) => {
          fs.cpSync(from, to, { recursive: true });
          writeFileSync(join(to, 'personas', 'persona-a.md'), 'alphX\n'); // same size, different bytes
        };
        await assert.rejects(moveInstall(src, installDir(), { copyFn: corruptCopy }), /content mismatch/);
        assert.deepEqual(snapshot(src), before);
        assert.equal(existsSync(installDir()), false);
      });

      it('verifyCopy flags a missing file', async () => {
        const src = fixture();
        const copy = join(home, 'copy');
        fs.cpSync(src, copy, { recursive: true });
        rmSync(join(copy, 'personas', 'persona-a.md'));
        await assert.rejects(verifyCopy(src, copy), /missing in copy/);
      });
    });
  });

  describe('status', () => {
    async function firstLine(options) {
      const { lines } = await captureLog(() => runStatus(options));
      return { first: lines[0], lines };
    }

    it('first line is "PRISM is enabled" when installed', async () => {
      await fakeInstall();
      const { first } = await firstLine();
      assert.ok(first.startsWith('PRISM is enabled'), first);
    });

    it('first line is "PRISM is disabled" when disabled', async () => {
      await fakeInstall();
      await disablePrism();
      const { first, lines } = await firstLine();
      assert.ok(first.startsWith('PRISM is disabled'), first);
      assert.ok(!lines.some(l => /Files:/.test(l)), 'no stash Files line');
    });

    it('first line contains "not installed" when absent', async () => {
      const { first, lines } = await firstLine();
      assert.ok(first.includes('not installed'), first);
      assert.equal(lines.length, 1);
    });

    it('legacy install detected: still "not installed" first, hint second', async () => {
      await legacyInstallAt(legacyRulesDir());
      const { first, lines } = await firstLine();
      assert.ok(first.includes('not installed'), first);
      assert.match(lines[1], /A legacy install was found at ~\/\.claude\/rules\/prism\/\. Run `npx prism-forge install` to migrate it to ~\/\.claude\/prism\/\./);
    });

    it('legacy stash detected too, but not when --path is given', async () => {
      await legacyInstallAt(legacyStashDir());
      let { first, lines } = await firstLine();
      assert.ok(first.includes('not installed'), first);
      assert.match(lines[1], /legacy install was found at ~\/\.claude\/prism-disabled\/prism\//);

      ({ first, lines } = await firstLine({ path: join(home, 'nowhere') }));
      assert.ok(first.includes('not installed'), first);
      assert.equal(lines.length, 1);
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
    it('install re-enables, and uninstall removes everything including the flag', async () => {
      await captureLog(() => runInstall());
      await disablePrism();

      await captureLog(() => runInstall());
      assert.equal(readDisabledState(), null, 'install re-enabled PRISM');
      assert.ok(readFileSync(claudeMd(), 'utf-8').includes(START_DELIMITER));

      await disablePrism();
      await captureLog(() => runUninstall());
      assert.equal(readDisabledState(), null, 'flag removed');
      assert.equal(existsSync(join(installDir(), 'prism-manifest.json')), false);
      assert.deepEqual(mdFilesUnder(join(home, '.claude', 'rules')), []);
      assert.ok(!readFileSync(claudeMd(), 'utf-8').includes(START_DELIMITER));
    });

    it('uninstall removes a lock file a crashed toggle left behind', async () => {
      await captureLog(() => runInstall());
      writeFileSync(lockPath(), 'leftover');
      await captureLog(() => runUninstall());
      assert.equal(existsSync(lockPath()), false);
    });

    it('uninstall finds an install still at the legacy rules location', async () => {
      await legacyInstallAt(legacyRulesDir());
      await captureLog(() => runUninstall());
      assert.equal(existsSync(join(legacyRulesDir(), 'prism-manifest.json')), false);
      assert.equal(existsSync(join(installDir(), 'prism-manifest.json')), false);
      assert.deepEqual(mdFilesUnder(join(home, '.claude', 'rules')), []);
      assert.deepEqual(mdFilesUnder(installDir()), []);
      assert.ok(!readFileSync(claudeMd(), 'utf-8').includes(START_DELIMITER));
    });

    it('uninstall finds a legacy disabled stash and clears its flag', async () => {
      await legacyInstallAt(legacyStashDir());
      await removeBlock();
      mkdirSync(dirname(getFlagPath()), { recursive: true });
      writeFileSync(getFlagPath(), JSON.stringify({ target_dir: legacyRulesDir(), stash_dir: legacyStashDir() }));

      await captureLog(() => runUninstall());
      assert.equal(readDisabledState(), null);
      assert.deepEqual(mdFilesUnder(join(home, '.claude', 'prism-disabled')), []);
      assert.deepEqual(mdFilesUnder(installDir()), []);
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
        assert.equal(off.status, 0, off.error ?? off.stderr);
        assert.equal(off.stdout, '');

        const on = runHook(file, input, { disabled: false });
        assert.equal(on.status, 0, on.error ?? on.stderr);
        assert.match(on.stdout, /additionalContext/);
      });
    }

    it('prism_check_attribution.py logs nothing when disabled', () => {
      const transcript = join(home, 'transcript.jsonl');
      writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: 'ok' } }) + '\n');
      const input = { transcript_path: transcript, session_id: 's', hook_event_name: 'Stop' };
      const log = join(home, '.claude', 'hooks', 'prism_routing_events.jsonl');

      const off = runHook('prism_check_attribution.py', input, { disabled: true });
      assert.equal(off.status, 0, off.error ?? off.stderr);
      assert.equal(off.stdout, '');
      assert.equal(existsSync(log), false, 'no drift event logged');

      const on = runHook('prism_check_attribution.py', input, { disabled: false });
      assert.equal(on.status, 0, on.error ?? on.stderr);
      assert.ok(existsSync(log), 'event logged when enabled');
    });
  });
});
