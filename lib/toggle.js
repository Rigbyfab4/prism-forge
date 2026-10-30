import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { getTargetDir, tildePathCustom, getLegacyRulesDir, getLegacyStashDir } from './paths.js';
import { injectBlock, removeBlock } from './claude-md.js';

// The hooks look for this file next to themselves and exit silently when it exists.
export const DISABLED_FLAG = '.prism-disabled';
const LOCK_FILE = '.prism-toggle.lock';

export function getFlagPath() {
  return join(homedir(), '.claude', 'hooks', DISABLED_FLAG);
}

function getLockPath() {
  return join(homedir(), '.claude', 'hooks', LOCK_FILE);
}

/**
 * Read the disabled state.
 * @returns {object|null} State recorded by disablePrism(), or null when PRISM is enabled
 */
export function readDisabledState() {
  const flagPath = getFlagPath();
  if (!existsSync(flagPath)) return null;
  try {
    return JSON.parse(readFileSync(flagPath, 'utf-8'));
  } catch {
    // Flag present but unreadable: still disabled, but nothing to restore from
    return {};
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run fn while holding the toggle lock, so concurrent disable/enable runs are
 * serialized. The lock is an exclusively created file; a lock older than staleMs
 * is assumed to belong to a dead process and is taken over.
 * @param {Function} fn - Async or sync function to run
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] - How long to wait for a held lock
 * @param {number} [opts.staleMs=60000] - Age after which a lock is considered abandoned
 */
export async function withLock(fn, { timeoutMs = 10000, staleMs = 60000 } = {}) {
  const lockPath = getLockPath();
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const token = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: Math.random().toString(36).slice(2) });

  // Acquire
  for (;;) {
    try {
      writeFileSync(lockPath, token, { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // vanished between attempts: retry immediately
      }
      if (age > staleMs) {
        try { unlinkSync(lockPath); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('Another PRISM disable/enable is in progress (lock: ~/.claude/hooks/.prism-toggle.lock). Try again in a moment.');
      }
      await sleep(50);
    }
  }

  // Held: run, then release only the lock we created
  try {
    return await fn();
  } finally {
    try {
      if (readFileSync(lockPath, 'utf-8') === token) unlinkSync(lockPath);
    } catch {
      // Already gone (ENOENT) or replaced by someone else: not ours to remove
    }
  }
}

function lockOptions(options) {
  const o = {};
  if (options.lockTimeoutMs !== undefined) o.timeoutMs = options.lockTimeoutMs;
  if (options.lockStaleMs !== undefined) o.staleMs = options.lockStaleMs;
  return o;
}

/**
 * Turn PRISM off without uninstalling: the hooks go silent and the CLAUDE.md block
 * is removed. The install directory is left exactly where it is; it lives outside
 * ~/.claude/rules/, so Claude Code no longer loads it once the block is gone.
 * @param {object} [options]
 * @param {string} [options.path] - Custom install directory
 * @returns {object} { changed, state }
 * @throws {Error} If PRISM is not installed at the target, or the CLAUDE.md edit fails
 */
export async function disablePrism(options = {}) {
  return withLock(async () => {
    const existing = readDisabledState();
    if (existing) return { changed: false, state: existing };

    const targetDir = resolve(getTargetDir(options.path));
    if (!existsSync(join(targetDir, 'prism-manifest.json'))) {
      throw new Error(`No PRISM installation found at ${tildePathCustom(targetDir)}/`);
    }

    // Flag first, so the hooks stop as soon as possible. 'wx' means we only ever
    // own a flag we created ourselves.
    const flagPath = getFlagPath();
    const disabledAt = new Date().toISOString();
    mkdirSync(dirname(flagPath), { recursive: true });
    let createdFlag = false;
    try {
      writeFileSync(flagPath, JSON.stringify({ disabled_at: disabledAt }, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
      createdFlag = true;
    } catch (err) {
      if (err.code === 'EEXIST') return { changed: false, state: readDisabledState() };
      throw err;
    }

    try {
      await removeBlock();
    } catch (err) {
      // removeBlock edits CLAUDE.md atomically, so a failure leaves it untouched.
      // Remove the flag we created (and only that one) so PRISM isn't left half-disabled.
      if (createdFlag) {
        try { unlinkSync(flagPath); } catch {}
      }
      throw new Error(`Could not disable PRISM (${err.message}). PRISM is still enabled.`);
    }

    return { changed: true, state: { disabled_at: disabledAt, target_dir: targetDir } };
  }, lockOptions(options));
}

/**
 * Undo disablePrism(). The install location is always recomputed; nothing in the
 * flag file is trusted for paths.
 * @param {object} [options]
 * @param {string} [options.path] - Custom install directory
 * @param {boolean} [options.injectClaudeMd=true] - Put the CLAUDE.md block back (install/uninstall skip this)
 * @returns {object} { changed, state }
 * @throws {Error} If the CLAUDE.md edit fails, or PRISM was disabled by an older version that stashed the files
 */
export async function enablePrism(options = {}) {
  const { injectClaudeMd = true } = options;
  return withLock(async () => {
    const state = readDisabledState();
    if (!state) return { changed: false, state: null };

    const targetDir = resolve(getTargetDir(options.path));
    const hasInstall = existsSync(join(targetDir, 'prism-manifest.json'));

    // Older versions moved the install to ~/.claude/prism-disabled/prism. `install`
    // migrates it; enabling can't do that safely without re-writing token paths.
    // Only checked when `install` isn't already doing that work (injectClaudeMd:false).
    if (injectClaudeMd && !hasInstall && existsSync(join(getLegacyStashDir(), 'prism-manifest.json'))) {
      throw new Error(
        'PRISM was disabled by an older version; its files are at ~/.claude/prism-disabled/prism/. ' +
        'Run `npx prism-forge install` to migrate and re-enable.'
      );
    }

    if (injectClaudeMd && hasInstall) {
      // Errors propagate and the flag stays, so the state remains "disabled"
      await injectBlock(targetDir);
    }

    // Flag last, so the hooks don't run against a half-restored install
    try { unlinkSync(getFlagPath()); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return { changed: true, state: { ...state, target_dir: targetDir } };
  }, lockOptions(options));
}

export async function runDisable(options = {}) {
  try {
    const { changed, state } = await disablePrism(options);
    if (!changed) {
      console.log('PRISM is already disabled. Run `npx prism-forge enable` to turn it back on.');
      return;
    }
    const target = resolve(getTargetDir(options.path));
    console.log('PRISM disabled.\n');
    console.log('  Hooks:     silent (still registered, settings.json unchanged)');
    console.log('  CLAUDE.md: PRISM block removed');
    console.log(`  Files:     left in place at ${tildePathCustom(target)}/ (not loaded automatically)`);
    console.log('\nStart a new Claude Code session for this to take full effect.');
    console.log('Run `npx prism-forge enable` to turn PRISM back on.');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

export async function runEnable(options = {}) {
  try {
    const { changed } = await enablePrism(options);
    if (!changed) {
      console.log('PRISM is already enabled.');
      return;
    }
    const target = resolve(getTargetDir(options.path));
    console.log('PRISM enabled.\n');
    console.log(`  Files:     ${tildePathCustom(target)}/`);
    console.log('  CLAUDE.md: PRISM block restored');
    console.log('  Hooks:     active');
    console.log('\nStart a new Claude Code session for this to take full effect.');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// NOTE: the first stdout line is a contract with external tooling. It must start with
// "PRISM is enabled" or "PRISM is disabled", or contain "not installed".
export async function runStatus(options = {}) {
  const state = readDisabledState();
  if (state) {
    const since = state.disabled_at ? ` since ${state.disabled_at}` : '';
    console.log(`PRISM is disabled${since}.`);
    console.log('Run `npx prism-forge enable` to turn it back on.');
    return { enabled: false, state };
  }
  const targetDir = getTargetDir(options.path);
  if (existsSync(join(targetDir, 'prism-manifest.json'))) {
    console.log(`PRISM is enabled (${tildePathCustom(targetDir)}/).`);
    console.log('Run `npx prism-forge disable` to turn it off without uninstalling.');
    return { enabled: true, state: null };
  }
  console.log(`PRISM is not installed at ${tildePathCustom(targetDir)}/.`);
  if (!options.path) {
    for (const legacy of [getLegacyRulesDir(), getLegacyStashDir()]) {
      if (existsSync(join(legacy, 'prism-manifest.json'))) {
        console.log(`A legacy install was found at ${tildePathCustom(legacy)}/. Run \`npx prism-forge install\` to migrate it to ~/.claude/prism/.`);
        break;
      }
    }
  }
  return { enabled: false, state: null, installed: false };
}
