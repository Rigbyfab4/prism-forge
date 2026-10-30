import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getDefaultTargetDir() {
  return join(homedir(), '.claude', 'prism');
}

// Where installs lived before the default moved out of ~/.claude/rules/
// (Claude Code auto-loads every .md under rules/). Computed at call time so
// tests can point HOME at a temp folder.
export function getLegacyRulesDir() {
  return join(homedir(), '.claude', 'rules', 'prism');
}

// Where the old `disable` parked an install
export function getLegacyStashDir() {
  return join(homedir(), '.claude', 'prism-disabled', 'prism');
}

export function getTargetDir(customPath) {
  if (customPath) return customPath;
  return getDefaultTargetDir();
}

export function getClaudeMdPath() {
  return join(homedir(), '.claude', 'CLAUDE.md');
}

export function getSourceDir() {
  return join(__dirname, '..', 'src');
}

export function tildePath(subpath) {
  return '~/.claude/prism' + (subpath ? '/' + subpath : '');
}

export function tildePathCustom(targetDir, subpath) {
  const home = homedir();
  const full = join(targetDir, subpath || '');
  if (full.startsWith(home)) {
    return '~' + full.slice(home.length).replace(/\\/g, '/');
  }
  return full.replace(/\\/g, '/');
}
