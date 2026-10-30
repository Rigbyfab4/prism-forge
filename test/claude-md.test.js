import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, rm, readdir, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { injectBlock, removeBlock, START_DELIMITER, END_DELIMITER } from '../lib/claude-md.js';

const testDir = join(tmpdir(), 'prism-test-' + Date.now());
const testClaudeMd = join(testDir, 'CLAUDE.md');
const testTargetDir = join(testDir, 'rules', 'prism');

describe('claude-md block injection', () => {
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates CLAUDE.md if it does not exist', async () => {
    const result = await injectBlock(testTargetDir, testClaudeMd);
    assert.equal(result, 'created');
    const content = await readFile(testClaudeMd, 'utf-8');
    assert.ok(content.includes(START_DELIMITER));
    assert.ok(content.includes(END_DELIMITER));
  });

  it('appends block to existing CLAUDE.md without PRISM block', async () => {
    await writeFile(testClaudeMd, '# My Config\n\nSome content.\n', 'utf-8');
    const result = await injectBlock(testTargetDir, testClaudeMd);
    assert.equal(result, 'appended');
    const content = await readFile(testClaudeMd, 'utf-8');
    assert.ok(content.includes('# My Config'));
    assert.ok(content.includes(START_DELIMITER));
  });

  it('replaces existing PRISM block', async () => {
    const existing = `# Config\n\n${START_DELIMITER}\nold content\n${END_DELIMITER}\n\n# Footer\n`;
    await writeFile(testClaudeMd, existing, 'utf-8');
    const result = await injectBlock(testTargetDir, testClaudeMd);
    assert.equal(result, 'replaced');
    const content = await readFile(testClaudeMd, 'utf-8');
    assert.ok(!content.includes('old content'));
    assert.ok(content.includes('# Config'));
    assert.ok(content.includes('# Footer'));
    assert.ok(content.includes(START_DELIMITER));
  });
});

describe('claude-md block removal', () => {
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('removes PRISM block and preserves surrounding content', async () => {
    const content = `# Config\n\n${START_DELIMITER}\nPRISM content\n${END_DELIMITER}\n\n# Footer\n`;
    await writeFile(testClaudeMd, content, 'utf-8');
    const result = await removeBlock(testClaudeMd);
    assert.equal(result, true);
    const after = await readFile(testClaudeMd, 'utf-8');
    assert.ok(!after.includes(START_DELIMITER));
    assert.ok(!after.includes('PRISM content'));
    assert.ok(after.includes('# Config'));
    assert.ok(after.includes('# Footer'));
  });

  it('returns false when no PRISM block exists', async () => {
    await writeFile(testClaudeMd, '# Config\n', 'utf-8');
    const result = await removeBlock(testClaudeMd);
    assert.equal(result, false);
  });

  it('returns false when file does not exist', async () => {
    const result = await removeBlock(join(testDir, 'nonexistent.md'));
    assert.equal(result, false);
  });

  it('handles file that becomes empty after removal', async () => {
    const content = `${START_DELIMITER}\nonly PRISM content\n${END_DELIMITER}`;
    await writeFile(testClaudeMd, content, 'utf-8');
    const result = await removeBlock(testClaudeMd);
    assert.equal(result, true);
    const after = await readFile(testClaudeMd, 'utf-8');
    assert.equal(after, '');
  });
});

describe('claude-md byte-exact removal', () => {
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const block = `${START_DELIMITER}\nPRISM content\n${END_DELIMITER}`;

  it('leaves everything outside the block byte-identical', async () => {
    const beforePart =
      '# Top   \n\n\n\n\n\nText with trailing spaces   \n' +
      '```\ncode\n\n\n\n\nmore code\n```\n\n\n\n\n';
    const afterPart = '\n\n\n\n\n# Bottom\t\n\n\n\n  indented  \n\n\n';
    await writeFile(testClaudeMd, beforePart + block + '\n' + afterPart, 'utf-8');
    assert.equal(await removeBlock(testClaudeMd), true);
    assert.equal(await readFile(testClaudeMd, 'utf-8'), beforePart + afterPart);
  });

  it('removes a block at the end of file without trailing newline', async () => {
    await writeFile(testClaudeMd, `intro\n\n${block}`, 'utf-8');
    assert.equal(await removeBlock(testClaudeMd), true);
    assert.equal(await readFile(testClaudeMd, 'utf-8'), 'intro\n\n');
  });

  it('removes a block at the start of file', async () => {
    await writeFile(testClaudeMd, `${block}\n\n\n\nrest\n`, 'utf-8');
    assert.equal(await removeBlock(testClaudeMd), true);
    assert.equal(await readFile(testClaudeMd, 'utf-8'), '\n\n\nrest\n');
  });

  it('removes the CRLF terminator after the block and leaves other CRLF untouched', async () => {
    const beforePart = 'line1\r\n\r\n\r\n\r\n';
    const afterPart = '\r\n\r\n# Footer\r\n\r\n\r\n';
    const crlfBlock = `${START_DELIMITER}\r\nPRISM\r\n${END_DELIMITER}`;
    await writeFile(testClaudeMd, beforePart + crlfBlock + '\r\n' + afterPart, 'utf-8');
    assert.equal(await removeBlock(testClaudeMd), true);
    assert.equal(await readFile(testClaudeMd, 'utf-8'), beforePart + afterPart);
  });

  it('removes exactly the span when the block is not at line start', async () => {
    await writeFile(testClaudeMd, `text ${block} tail\nnext\n`, 'utf-8');
    assert.equal(await removeBlock(testClaudeMd), true);
    assert.equal(await readFile(testClaudeMd, 'utf-8'), 'text  tail\nnext\n');
  });

  it('removes exactly the span when text follows the end marker on the same line', async () => {
    await writeFile(testClaudeMd, `a\n${block} tail\nb\n`, 'utf-8');
    assert.equal(await removeBlock(testClaudeMd), true);
    assert.equal(await readFile(testClaudeMd, 'utf-8'), 'a\n tail\nb\n');
  });

  it('returns false and leaves file unchanged when END precedes START', async () => {
    const content = `x\n${END_DELIMITER}\ny\n${START_DELIMITER}\nz\n`;
    await writeFile(testClaudeMd, content, 'utf-8');
    assert.equal(await removeBlock(testClaudeMd), false);
    assert.equal(await readFile(testClaudeMd, 'utf-8'), content);
  });

  it('returns false and leaves file unchanged when only START is present', async () => {
    const content = `x\n${START_DELIMITER}\nz\n`;
    await writeFile(testClaudeMd, content, 'utf-8');
    assert.equal(await removeBlock(testClaudeMd), false);
    assert.equal(await readFile(testClaudeMd, 'utf-8'), content);
  });
});

describe('claude-md inject/remove cycles and atomic writes', () => {
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('inject -> remove -> inject is stable for a file ending in a single newline', async () => {
    await writeFile(testClaudeMd, '# Mine\n\ncontent\n', 'utf-8');
    await injectBlock(testTargetDir, testClaudeMd);
    const firstInject = await readFile(testClaudeMd, 'utf-8');
    await removeBlock(testClaudeMd);
    const firstRemove = await readFile(testClaudeMd, 'utf-8');
    await injectBlock(testTargetDir, testClaudeMd);
    const secondInject = await readFile(testClaudeMd, 'utf-8');
    await removeBlock(testClaudeMd);
    const secondRemove = await readFile(testClaudeMd, 'utf-8');
    assert.equal(secondInject, firstInject);
    assert.equal(secondRemove, firstRemove);
  });

  it('inject then remove on a file without trailing newline preserves original text', async () => {
    await writeFile(testClaudeMd, '# Mine\n\ncontent', 'utf-8');
    assert.equal(await injectBlock(testTargetDir, testClaudeMd), 'appended');
    assert.equal(await removeBlock(testClaudeMd), true);
    const after = await readFile(testClaudeMd, 'utf-8');
    assert.ok(after.startsWith('# Mine\n\ncontent'));
    assert.ok(!after.includes(START_DELIMITER));
    assert.equal(after.trimEnd(), '# Mine\n\ncontent');
  });

  it('replace keeps content outside the block byte-identical', async () => {
    const beforePart = '# A\n\n\n\n\nx   \n';
    const afterPart = '\n\n\n\ntail\n\n\n';
    await writeFile(
      testClaudeMd,
      `${beforePart}${START_DELIMITER}\nold\n${END_DELIMITER}${afterPart}`,
      'utf-8'
    );
    assert.equal(await injectBlock(testTargetDir, testClaudeMd), 'replaced');
    const content = await readFile(testClaudeMd, 'utf-8');
    assert.ok(content.startsWith(beforePart + START_DELIMITER));
    assert.ok(content.endsWith(END_DELIMITER + afterPart));
  });

  it('leaves no .prism-tmp-* files behind', async () => {
    await writeFile(testClaudeMd, '# Mine\n', 'utf-8');
    await injectBlock(testTargetDir, testClaudeMd);
    await injectBlock(testTargetDir, testClaudeMd);
    await removeBlock(testClaudeMd);
    const created = join(testDir, 'sub', 'CLAUDE.md');
    await injectBlock(testTargetDir, created);
    const leftovers = [...(await readdir(testDir)), ...(await readdir(join(testDir, 'sub')))]
      .filter((n) => n.includes('.prism-tmp-'));
    assert.deepEqual(leftovers, []);
  });

  it('updates a symlinked CLAUDE.md in place instead of replacing the link', async (t) => {
    const realFile = join(testDir, 'real-claude.md');
    const link = join(testDir, 'link-claude.md');
    await writeFile(realFile, '# Real\n', 'utf-8');
    try {
      await symlink(realFile, link);
    } catch {
      t.skip('symlink creation not permitted');
      return;
    }
    await injectBlock(testTargetDir, link);
    assert.ok((await lstat(link)).isSymbolicLink());
    assert.ok((await readFile(realFile, 'utf-8')).includes(START_DELIMITER));
    await removeBlock(link);
    assert.ok((await lstat(link)).isSymbolicLink());
    assert.ok(!(await readFile(realFile, 'utf-8')).includes(START_DELIMITER));
  });
});
