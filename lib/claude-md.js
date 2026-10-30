import { readFile, writeFile, mkdir, realpath, stat, chmod, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { replaceTokens } from './tokens.js';
import { getSourceDir, getClaudeMdPath } from './paths.js';

const START_DELIMITER = '<!-- PRISM:START -->';
const END_DELIMITER = '<!-- PRISM:END -->';

async function getBlockContent(targetDir) {
  const sourceDir = getSourceDir();
  const blockPath = join(sourceDir, 'routing', 'claude-md-block.md');
  const raw = await readFile(blockPath, 'utf-8');
  return replaceTokens(raw, targetDir);
}

function wrapBlock(content) {
  return `${START_DELIMITER}\n${content.trim()}\n${END_DELIMITER}`;
}

// Write via a temp file in the same directory, then rename over the target, so a
// crash can never leave a truncated CLAUDE.md. A symlinked target is resolved
// first so the link's destination is updated in place.
async function writeFileAtomic(targetPath, data) {
  let realTarget = targetPath;
  let mode;
  try {
    realTarget = await realpath(targetPath);
    mode = (await stat(realTarget)).mode & 0o7777;
  } catch {
    // target does not exist yet: write a new regular file
  }
  const tmpPath = `${realTarget}.prism-tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmpPath, data, 'utf-8');
    if (mode !== undefined) {
      try {
        await chmod(tmpPath, mode);
      } catch {
        // best effort only
      }
    }
    await rename(tmpPath, realTarget);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

export async function injectBlock(targetDir, claudeMdPath) {
  const mdPath = claudeMdPath || getClaudeMdPath();
  const blockContent = await getBlockContent(targetDir);
  const wrapped = wrapBlock(blockContent);

  let existing = '';
  try {
    existing = await readFile(mdPath, 'utf-8');
  } catch {
    await mkdir(dirname(mdPath), { recursive: true });
    await writeFileAtomic(mdPath, wrapped + '\n');
    return 'created';
  }

  const startIdx = existing.indexOf(START_DELIMITER);
  const endIdx = startIdx === -1 ? -1 : existing.indexOf(END_DELIMITER, startIdx);

  if (startIdx !== -1 && endIdx !== -1) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + END_DELIMITER.length);
    await writeFileAtomic(mdPath, before + wrapped + after);
    return 'replaced';
  }

  // Separator chosen so inject -> remove -> inject does not grow blank lines.
  let separator;
  if (existing === '') separator = '';
  else if (existing.endsWith('\n\n') || existing.endsWith('\r\n\r\n')) separator = '';
  else if (existing.endsWith('\n')) separator = '\n';
  else separator = '\n\n';
  await writeFileAtomic(mdPath, existing + separator + wrapped + '\n');
  return 'appended';
}

export async function removeBlock(claudeMdPath) {
  const mdPath = claudeMdPath || getClaudeMdPath();

  let content;
  try {
    content = await readFile(mdPath, 'utf-8');
  } catch {
    return false;
  }

  const startIdx = content.indexOf(START_DELIMITER);
  if (startIdx === -1) return false;
  const endMarkerIdx = content.indexOf(END_DELIMITER, startIdx);
  if (endMarkerIdx === -1) return false;

  // Splice out only the block. If it occupies whole lines, also drop its one
  // trailing line terminator. Nothing else in the file is touched.
  let removeEnd = endMarkerIdx + END_DELIMITER.length;
  const atLineStart = startIdx === 0 || content[startIdx - 1] === '\n';
  if (atLineStart) {
    if (content.startsWith('\r\n', removeEnd)) removeEnd += 2;
    else if (content[removeEnd] === '\n') removeEnd += 1;
  }

  await writeFileAtomic(mdPath, content.slice(0, startIdx) + content.slice(removeEnd));
  return true;
}

export { START_DELIMITER, END_DELIMITER };
