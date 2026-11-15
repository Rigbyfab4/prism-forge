#!/usr/bin/env node
// Free, offline checks of the eval itself (no model calls):
//  1. coding oracle: fixture + reference solution must pass its hidden tests
//  2. coding null: the untouched fixture must FAIL its hidden tests
//  3. every case file parses, ids are unique, checks/rubrics are well-formed
//  4. persona-tag detection and blinding behave on known strings
//
//   node test/selftest.mjs

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blind, countPersonaTags, listItems } from '../lib/checks.mjs';
import { EVAL_ROOT } from '../lib/source.mjs';
import { inheritedMemory } from '../lib/tmp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

function hiddenTests(fixture, hidden, oracle) {
  const ws = mkdtempSync(join(tmpdir(), 'pfe-self-'));
  try {
    cpSync(join(EVAL_ROOT, 'fixtures', fixture), ws, { recursive: true });
    if (oracle) cpSync(join(EVAL_ROOT, 'oracle', oracle), ws, { recursive: true });
    cpSync(join(EVAL_ROOT, 'hidden', hidden), join(ws, '__hidden_tests__'), { recursive: true });
    const files = readdirSync(join(ws, '__hidden_tests__')).filter(f => f.endsWith('.test.js')).map(f => join('__hidden_tests__', f));
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: ws, encoding: 'utf8' });
    const n = (k) => Number((r.stdout.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] ?? NaN);
    return { status: r.status, pass: n('pass'), fail: n('fail') };
  } finally { rmSync(ws, { recursive: true, force: true }); }
}

// --- cases ----------------------------------------------------------------
const ids = new Set();
const all = [];
for (const dir of ['cases', 'cases-toggle']) {
  for (const f of readdirSync(join(EVAL_ROOT, dir)).filter(f => f.endsWith('.json'))) {
    let cases;
    try { cases = JSON.parse(readFileSync(join(EVAL_ROOT, dir, f), 'utf8')); }
    catch (e) { ok(false, `${dir}/${f} parses (${e.message})`); continue; }
    for (const c of cases) {
      all.push({ ...c, _dir: dir });
      ok(!ids.has(c.id), `${c.id}: unique id`);
      ids.add(c.id);
      ok(typeof c.category === 'string' && Array.isArray(c.turns) && c.turns.length > 0, `${c.id}: has category and turns`);
      for (const ck of c.checks || []) {
        if (ck.pattern) { try { new RegExp(ck.pattern, ck.flags ?? 'i'); } catch { ok(false, `${c.id}: regex ${ck.pattern} compiles`); } }
        if (typeof ck.turn === 'number') ok(ck.turn >= 1 && ck.turn <= c.turns.length, `${c.id}: check turn ${ck.turn} in range`);
      }
      if (dir === 'cases') ok((c.rubric?.length || 0) > 0, `${c.id}: has a rubric`);
      for (const r of c.rubric || []) ok(r.id && r.text, `${c.id}: rubric item well-formed`);
      if (c.workspace) ok(existsSync(join(EVAL_ROOT, 'fixtures', c.workspace)), `${c.id}: fixture ${c.workspace} exists`);
    }
  }
}
const byCat = {};
for (const c of all.filter(c => c._dir === 'cases')) byCat[c.category] = (byCat[c.category] || 0) + 1;
console.log('cases per category:', JSON.stringify(byCat), `total ${all.filter(c => c._dir === 'cases').length}; toggle ${all.filter(c => c._dir === 'cases-toggle').length}`);

// --- coding oracle / null -------------------------------------------------
for (const c of all.filter(c => c.hidden)) {
  const oracle = existsSync(join(EVAL_ROOT, 'oracle', c.hidden)) ? c.hidden : null;
  ok(oracle, `${c.id}: has a reference solution`);
  if (oracle) {
    const good = hiddenTests(c.workspace, c.hidden, oracle);
    ok(good.status === 0 && good.fail === 0 && good.pass > 0, `${c.id}: reference passes hidden tests (${good.pass} pass, ${good.fail} fail)`);
  }
  const bad = hiddenTests(c.workspace, c.hidden, null);
  if (c.null_passes_tests) {
    // Behaviour-preservation case: doing nothing passes the tests by design,
    // so the case must carry a no-op detector that fails the untouched fixture
    ok(bad.status === 0, `${c.id}: untouched fixture passes behaviour tests, as designed (${bad.pass} pass)`);
    ok((c.checks || []).some(k => k.type === 'files_changed'), `${c.id}: has a no-op detector (files_changed)`);
  } else {
    ok(bad.status !== 0 && bad.fail > 0, `${c.id}: untouched fixture fails hidden tests (${bad.pass} pass, ${bad.fail} fail)`);
  }
}

// --- persona tags / blinding ---------------------------------------------
const sample = '**Dr. Quinn (Creative Problem Solver):**\nCheck the token clock skew first.\n\n**Mary (Business Analyst):**\nAlso confirm the expiry config.\nSusie (Chief of Staff)\n**Winston (Architect)** is in the room.';
ok(countPersonaTags(sample) === 2, 'detects **Name (Role):** tags');
const b = blind(sample);
ok(!/Quinn|Mary|Susie|Winston|Architect/.test(b) && b.includes('clock skew') && b.includes('expiry config'), 'blind() strips labels and roster, keeps content');
ok(countPersonaTags('Use **bold (not a persona)** text and **Note:** here.') === 0, 'no false positive on ordinary bold text');
ok(listItems('- a\n- b\n* c\n1. d\n2) e\nnot a list') === 5, 'counts list items');

// --- inherited memory guard ---------------------------------------------------
{
  const top = mkdtempSync(join(tmpdir(), 'pfe-mem-'));
  try {
    const deep = join(top, 'a', 'b');
    mkdirSync(join(top, '.claude'), { recursive: true });
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(top, '.claude', 'CLAUDE.md'), 'x');
    ok(inheritedMemory(deep).includes(join(top, '.claude', 'CLAUDE.md')), 'inheritedMemory finds a parent .claude/CLAUDE.md');
  } finally { rmSync(top, { recursive: true, force: true }); }
}

console.log(failures ? `\n${failures} FAILED` : '\nall selftests passed');
process.exit(failures ? 1 : 0);
