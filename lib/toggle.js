import { join, dirname, basename, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, cpSync, rmSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { getTargetDir, tildePathCustom } from './paths.js';
import { injectBlock, removeBlock } from './claude-md.js';

// The hooks look for this file next to themselves and exit silently when it exists.
export const DISABLED_FLAG = '.prism-disabled';

export function getFlagPath() {
  return join(homedir(), '.claude', 'hooks', DISABLED_FLAG);
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

/**
 * Where to move an install while disabled. Claude Code loads every .md file under
 * a .claude/rules/ directory, so an install there must leave it to stop loading.
 * ~/.claude/rules/prism -> ~/.claude/prism-disabled/prism
 * @param {string} targetDir - Install directory
 * @returns {string|null} Stash directory, or null if the install is not under .claude/rules/
 */
export function getStashDir(targetDir) {
  const parts = resolve(targetDir).split(/[\\/]/);
  for (let i = parts.length - 2; i >= 1; i--) {
    if (parts[i] === 'rules' && parts[i - 1] === '.claude') {
      return [...parts.slice(0, i), 'prism-disabled', ...parts.slice(i + 1)].join(sep);
    }
  }
  return null;
}

function moveDir(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    // Windows can refuse to rename a directory something has open; copy instead
    if (!['EPERM', 'EBUSY', 'EXDEV', 'EACCES'].includes(err.code)) throw err;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

// After restoring, remove the empty .claude/prism-disabled/ folders the stash leaves behind
function removeEmptyParents(stashDir) {
  let dir = dirname(stashDir);
  while (basename(dir) !== '.claude' && dir !== dirname(dir)) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    if (basename(dir) === 'prism-disabled') return;
    dir = dirname(dir);
  }
}

/**
 * Turn PRISM off without uninstalling: the hooks go silent, the CLAUDE.md block is
 * removed and the install directory is moved out of .claude/rules/.
 * @param {object} [options]
 * @param {string} [options.path] - Custom install directory
 * @returns {object} { changed, state }
 * @throws {Error} If PRISM is not installed at the target, or the stash location is taken
 */
export async function disablePrism(options = {}) {
  const existing = readDisabledState();
  if (existing) return { changed: false, state: existing };

  const targetDir = resolve(getTargetDir(options.path));
  if (!existsSync(join(targetDir, 'prism-manifest.json'))) {
    throw new Error(`No PRISM installation found at ${tildePathCustom(targetDir)}/`);
  }
  const stashDir = getStashDir(targetDir);
  if (stashDir && existsSync(stashDir)) {
    throw new Error(`${tildePathCustom(stashDir)}/ already exists. Move it aside, then re-run.`);
  }

  const state = {
    disabled_at: new Date().toISOString(),
    target_dir: targetDir,
    stash_dir: stashDir,
  };

  // Flag first, so the hooks stop as soon as possible
  const flagPath = getFlagPath();
  mkdirSync(dirname(flagPath), { recursive: true });
  writeFileSync(flagPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');

  const blockRemoved = await removeBlock();
  try {
    if (stashDir) moveDir(targetDir, stashDir);
  } catch (err) {
    // Roll back so PRISM isn't left half-disabled
    if (blockRemoved) await injectBlock(targetDir);
    unlinkSync(flagPath);
    throw new Error(`Could not move ${tildePathCustom(targetDir)}/ (${err.message}). PRISM is still enabled.`);
  }

  return { changed: true, state };
}

/**
 * Undo disablePrism().
 * @param {object} [options]
 * @param {boolean} [options.injectClaudeMd=true] - Put the CLAUDE.md block back (uninstall skips this)
 * @returns {object} { changed, state }
 * @throws {Error} If the install can't be restored to its original location
 */
export async function enablePrism(options = {}) {
  const { injectClaudeMd = true } = options;
  const state = readDisabledState();
  if (!state) return { changed: false, state: null };

  const { target_dir: targetDir, stash_dir: stashDir } = state;
  if (stashDir && existsSync(stashDir)) {
    if (existsSync(targetDir)) {
      throw new Error(`Both ${tildePathCustom(stashDir)}/ and ${tildePathCustom(targetDir)}/ exist. Remove one, then re-run.`);
    }
    moveDir(stashDir, targetDir);
    removeEmptyParents(stashDir);
  }
  if (injectClaudeMd && targetDir && existsSync(targetDir)) {
    await injectBlock(targetDir);
  }

  // Flag last, so the hooks don't run against a half-restored install
  unlinkSync(getFlagPath());
  return { changed: true, state };
}

export async function runDisable(options = {}) {
  try {
    const { changed, state } = await disablePrism(options);
    if (!changed) {
      console.log('PRISM is already disabled. Run `npx prism-forge enable` to turn it back on.');
      return;
    }
    console.log('PRISM disabled.\n');
    console.log('  Hooks:     silent (still registered, settings.json unchanged)');
    console.log('  CLAUDE.md: PRISM block removed');
    if (state.stash_dir) {
      console.log(`  Files:     moved to ${tildePathCustom(state.stash_dir)}/`);
    }
    console.log('\nStart a new Claude Code session for this to take full effect.');
    console.log('Run `npx prism-forge enable` to turn PRISM back on.');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

export async function runEnable() {
  try {
    const { changed, state } = await enablePrism();
    if (!changed) {
      console.log('PRISM is already enabled.');
      return;
    }
    console.log('PRISM enabled.\n');
    if (state.target_dir) {
      console.log(`  Files:     ${tildePathCustom(state.target_dir)}/`);
    }
    console.log('  CLAUDE.md: PRISM block restored');
    console.log('  Hooks:     active');
    console.log('\nStart a new Claude Code session for this to take full effect.');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

export async function runStatus(options = {}) {
  const state = readDisabledState();
  if (state) {
    const since = state.disabled_at ? ` since ${state.disabled_at}` : '';
    console.log(`PRISM is disabled${since}.`);
    if (state.stash_dir) console.log(`  Files: ${tildePathCustom(state.stash_dir)}/`);
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
  return { enabled: false, state: null, installed: false };
}
