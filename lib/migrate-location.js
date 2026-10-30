import { join, dirname, relative } from 'node:path';
import { existsSync, mkdirSync, renameSync, cpSync, rmSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { getDefaultTargetDir, getLegacyRulesDir, getLegacyStashDir, tildePathCustom } from './paths.js';
import { hashFile } from './hash.js';

const FALLBACK_CODES = ['EPERM', 'EBUSY', 'EXDEV', 'EACCES'];

function hasManifest(dir) {
  return existsSync(join(dir, 'prism-manifest.json'));
}

function listFiles(dir, base = dir) {
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...listFiles(full, base));
    else files.push(relative(base, full));
  }
  return files;
}

/**
 * Check that every file under src exists in copy with the same size and content.
 * @throws {Error} On the first mismatch
 */
export async function verifyCopy(src, copy) {
  for (const rel of listFiles(src)) {
    const a = join(src, rel);
    const b = join(copy, rel);
    if (!existsSync(b)) throw new Error(`missing in copy: ${rel}`);
    if (statSync(a).size !== statSync(b).size) throw new Error(`size mismatch: ${rel}`);
    if ((await hashFile(a)) !== (await hashFile(b))) throw new Error(`content mismatch: ${rel}`);
  }
}

/**
 * Move src to dest. Tries a plain rename; where that is refused (Windows with open
 * handles, cross-device) falls back to copy, verify, rename-into-place, then delete
 * the source. The source is never touched until the copy is verified and in place.
 * @returns {Promise<{warning?: string}>}
 * @throws {Error} If the move fails; src is left untouched
 */
export async function moveInstall(src, dest, { copyFn = cpSync } = {}) {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
    return {};
  } catch (err) {
    if (!FALLBACK_CODES.includes(err.code)) {
      throw new Error(`Could not migrate ${tildePathCustom(src)} to ${tildePathCustom(dest)} (${err.message}). The old install was left in place.`);
    }
  }

  const tmp = `${dest}.migrating-${process.pid}`;
  try {
    rmSync(tmp, { recursive: true, force: true });
    copyFn(src, tmp, { recursive: true });
    await verifyCopy(src, tmp);
    renameSync(tmp, dest);
  } catch (err) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    throw new Error(`Could not migrate ${tildePathCustom(src)} to ${tildePathCustom(dest)} (${err.message}). The old install was left in place.`);
  }

  try {
    rmSync(src, { recursive: true, force: true });
  } catch (err) {
    return { warning: `old directory could not be fully removed: ${src} (${err.message})` };
  }
  if (existsSync(src)) {
    return { warning: `old directory could not be fully removed: ${src}` };
  }
  return {};
}

/**
 * Move a pre-relocation install (~/.claude/rules/prism, or the stash a disabled
 * install was parked in) to the new default location. Only meaningful for the
 * default location; callers skip it when --path was given.
 *
 * The files keep their old token paths until the caller re-runs the normal install
 * over the moved directory.
 * @param {object} [options]
 * @param {Function} [options.copyFn] - cpSync replacement (tests)
 * @returns {Promise<object>} { migrated, reason?, from?, to?, warning?, leftovers? }
 */
export async function migrateLegacyInstall(options = {}) {
  const dest = getDefaultTargetDir();
  const candidates = [getLegacyRulesDir(), getLegacyStashDir()].filter(hasManifest);

  if (hasManifest(dest)) {
    return { migrated: false, reason: 'target_exists', leftovers: candidates };
  }
  if (candidates.length === 0) {
    return { migrated: false, reason: 'none' };
  }

  const from = candidates[0];
  const { warning } = await moveInstall(from, dest, { copyFn: options.copyFn });

  // The stash leaves an empty ~/.claude/prism-disabled/ behind
  if (from === getLegacyStashDir()) {
    const stashRoot = dirname(from);
    try {
      if (readdirSync(stashRoot).length === 0) rmdirSync(stashRoot);
    } catch {}
  }

  const result = { migrated: true, from, to: dest };
  if (warning) result.warning = warning;
  return result;
}
