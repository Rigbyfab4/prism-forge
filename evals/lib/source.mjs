// Materialize a git ref of this repo into a cached folder, once per commit,
// so arms install exactly the code at that commit (not your working tree).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = join(EVAL_ROOT, '..');
const CACHE = join(EVAL_ROOT, '.cache', 'src');

const git = (args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function resolveRef(ref) {
  try {
    return git(['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    throw new Error(
      `git ref '${ref}' not found. Fetch its remote first (e.g. git fetch fork) or set "refs" in _state.json.`);
  }
}

const memo = new Map();

export function materializeRef(ref) {
  if (memo.has(ref)) return memo.get(ref);
  const sha = resolveRef(ref);
  const dir = join(CACHE, sha);
  if (!existsSync(join(dir, 'bin', 'prism-forge.js'))) {
    mkdirSync(CACHE, { recursive: true });
    const tmp = `${dir}.tmp-${process.pid}`;
    const tar = `${tmp}.tar`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    git(['archive', '--format=tar', '-o', tar, sha]);
    execFileSync('tar', ['-xf', tar, '-C', tmp], { stdio: 'ignore' });
    rmSync(tar, { force: true });
    try { renameSync(tmp, dir); } catch (e) {
      // Another worker won the race: keep theirs
      rmSync(tmp, { recursive: true, force: true });
      if (!existsSync(join(dir, 'bin', 'prism-forge.js'))) throw e;
    }
  }
  memo.set(ref, dir);
  return dir;
}

export function describeRef(ref) {
  const sha = resolveRef(ref);
  return { ref, sha, subject: git(['log', '-1', '--format=%s', sha]) };
}
