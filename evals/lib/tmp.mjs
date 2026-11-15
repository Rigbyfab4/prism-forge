// Where the eval's temp folders live, and a guard against inherited memory.
//
// Claude Code loads CLAUDE.md (and .claude/CLAUDE.md, CLAUDE.local.md) from
// the working directory AND every parent directory. On Windows the system
// temp folder sits inside the user's profile (C:\Users\<you>\AppData\Local\
// Temp), so a session started there walks up to C:\Users\<you> and loads the
// user's real ~/.claude/CLAUDE.md as project memory, contaminating every arm
// and the judge. So temp folders go under a root outside the profile
// (C:\pfe-tmp on Windows, the system temp elsewhere; EVAL_TMP overrides), and
// we refuse to run if that root still has memory files above it.

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const WIN = process.platform === 'win32';
const MEMORY_FILES = ['CLAUDE.md', 'CLAUDE.local.md', join('.claude', 'CLAUDE.md')];

export function tmpRoot() {
  return resolve(process.env.EVAL_TMP || (WIN ? 'C:\\pfe-tmp' : tmpdir()));
}

/** Memory files Claude Code would pick up from `dir` and its parents. */
export function inheritedMemory(dir) {
  const found = [];
  let d = resolve(dir);
  for (;;) {
    for (const f of MEMORY_FILES) if (existsSync(join(d, f))) found.push(join(d, f));
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return found;
}

// Organization-managed memory applies to every session and can't be avoided;
// preflight reports it so it's known to affect all arms equally
export function managedMemory() {
  const c = WIN
    ? ['C:\\Program Files\\ClaudeCode\\CLAUDE.md', 'C:\\ProgramData\\ClaudeCode\\CLAUDE.md']
    : ['/Library/Application Support/ClaudeCode/CLAUDE.md', '/etc/claude-code/CLAUDE.md'];
  return c.filter(p => existsSync(p));
}

let checked = false;
/** Throw (before anything is spent) if the temp root inherits memory files. */
export function assertTempRootClean() {
  const root = tmpRoot();
  mkdirSync(root, { recursive: true });
  if (!checked) {
    const found = inheritedMemory(root);
    if (found.length && process.env.EVAL_ALLOW_INHERITED_MEMORY !== '1') {
      throw Object.assign(new Error(
        `temp root ${root} has CLAUDE.md files above it that every session would load: ${found.join(', ')}. ` +
        'Set EVAL_TMP to a folder outside your home folder (e.g. C:\\pfe-tmp).'), { failure_class: 'harness' });
    }
    checked = true;
  }
  return root;
}

export function makeTemp(prefix) {
  return mkdtempSync(join(assertTempRootClean(), prefix));
}
