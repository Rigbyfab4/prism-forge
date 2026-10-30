import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDefaultTargetDir, getTargetDir, getClaudeMdPath, tildePath, tildePathCustom, getLegacyRulesDir, getLegacyStashDir,
} from '../lib/paths.js';

describe('getDefaultTargetDir', () => {
  it('is exactly ~/.claude/prism (outside rules/, which Claude Code auto-loads)', () => {
    assert.equal(getDefaultTargetDir(), join(homedir(), '.claude', 'prism'));
    assert.ok(!getDefaultTargetDir().includes(join('.claude', 'rules')));
  });
});

describe('legacy locations', () => {
  it('getLegacyRulesDir is ~/.claude/rules/prism', () => {
    assert.equal(getLegacyRulesDir(), join(homedir(), '.claude', 'rules', 'prism'));
  });

  it('getLegacyStashDir is ~/.claude/prism-disabled/prism', () => {
    assert.equal(getLegacyStashDir(), join(homedir(), '.claude', 'prism-disabled', 'prism'));
  });

  it('follow HOME at call time, not import time', () => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = join(tmpdir(), 'prism-paths-fake-home');
    try {
      assert.equal(getLegacyRulesDir(), join(homedir(), '.claude', 'rules', 'prism'));
      assert.equal(getLegacyStashDir(), join(homedir(), '.claude', 'prism-disabled', 'prism'));
      assert.equal(getDefaultTargetDir(), join(homedir(), '.claude', 'prism'));
      assert.ok(getDefaultTargetDir().startsWith(join(tmpdir(), 'prism-paths-fake-home')));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

describe('tildePath', () => {
  it('is ~/.claude/prism with no subpath', () => {
    assert.equal(tildePath(), '~/.claude/prism');
  });

  it('appends a subpath', () => {
    assert.equal(tildePath('personas'), '~/.claude/prism/personas');
  });
});

describe('getTargetDir', () => {
  it('returns custom path when provided', () => {
    assert.equal(getTargetDir('/custom/path'), '/custom/path');
  });

  it('returns default when no custom path', () => {
    const result = getTargetDir(undefined);
    assert.equal(result, getDefaultTargetDir());
  });
});

describe('getClaudeMdPath', () => {
  it('returns path to ~/.claude/CLAUDE.md', () => {
    const result = getClaudeMdPath();
    assert.ok(result.endsWith('CLAUDE.md'));
    assert.ok(result.includes('.claude'));
  });
});

describe('tildePathCustom', () => {
  it('converts home directory path to tilde notation', () => {
    const home = homedir();
    const targetDir = join(home, '.claude', 'prism');
    const result = tildePathCustom(targetDir, 'personas');
    assert.ok(result.startsWith('~'));
    assert.ok(result.includes('personas'));
    assert.ok(!result.includes(home));
  });

  it('uses forward slashes', () => {
    const home = homedir();
    const targetDir = join(home, '.claude', 'prism');
    const result = tildePathCustom(targetDir, 'routing');
    assert.ok(!result.includes('\\'));
  });

  it('handles no subpath', () => {
    const home = homedir();
    const targetDir = join(home, '.claude', 'prism');
    const result = tildePathCustom(targetDir);
    assert.ok(result.endsWith('prism'));
  });
});
