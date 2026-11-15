// Programmatic checks and behavioural measurements. No model calls here.

// Prism's attribution format: **Name (Role):** (the same pattern its Stop hook
// looks for), plus the **Name (Role)**: spelling.
export const PERSONA_TAG = /\*\*[A-Z][a-zA-Z. ]+ \([A-Za-z &/-]+\):\*\*|\*\*[A-Z][a-zA-Z. ]+ \([A-Za-z &/-]+\)\*\*:/g;
const SITREP = /\bsitrep\b|Active\s*\/\s*Blocked|^\s*\**(Active|Blocked|Stale|Recommended)\**\s*:/im;
const ROSTER = /^.*\b(is in the room|are in the room|joining|has entered|roster change|activating|activated)\b.*$/gim;

export const countPersonaTags = (s) => (s.match(PERSONA_TAG) || []).length;
export const hasSitrep = (s) => SITREP.test(s);
export const words = (s) => (s.trim().match(/\S+/g) || []).length;

// Remove what reveals the arm to a judge: attribution labels and roster lines.
// The content under each label stays. Imperfect by nature (a persona voice can
// still show through prose), which is why baseline-vs-arm wins are also run
// with the order swapped and why summarize.mjs reports persona-tag rates.
export function blind(s) {
  // A label alone on its line goes with its line break; one inline before
  // text goes with the space after it
  const tagLine = new RegExp(`^[ \\t]*(?:${PERSONA_TAG.source})[ \\t]*\\r?\\n`, 'gm');
  const tagInline = new RegExp(`(?:${PERSONA_TAG.source})[ \\t]*`, 'g');
  return s
    .replace(tagLine, '')
    .replace(tagInline, '')
    .replace(ROSTER, '')
    .replace(/^\s*(?:#+\s*)?(?:\*\*)?(?:Susie|Mary|Amelia|Bob|Quinn|Winston|John|Paige|Carson|Dr\. Quinn|Maya|Victor|Spike|Sophia|Sally|Leonardo|Dali|de Bono|Campbell|Jobs|Barry|Boris|Musk|Atlas|Morgan|Sagan|Phoenix|Koa)(?:\*\*)?\s*\((?:[A-Za-z &/-]+)\)\s*(?:\*\*)?:?\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Lines that start a list item: "-", "*", "•", "1.", "1)"
export const listItems = (s) => (s.match(/^\s*(?:[-*•]|\d+[.)])\s+\S/gm) || []).length;

function turnText(perTurn, turn) {
  const graded = perTurn.filter(t => !t.control);
  if (turn === 'all') return graded.map(t => t.text).join('\n\n');
  if (turn == null || turn === 'last') return graded.at(-1)?.text ?? '';
  // 1-based index over ALL turns as written in the case (control turns count)
  return perTurn[turn - 1]?.text ?? '';
}

/**
 * Evaluate a case's checks.
 * @returns {{ score: number|null, results: Array<{id, pass, detail}> }}
 */
export function runChecks(c, run) {
  const results = [];
  for (const [i, ck] of (c.checks || []).entries()) {
    const id = ck.id || `${ck.type}_${i + 1}`;
    const text = turnText(run.perTurn, ck.turn);
    let pass, detail = '';
    switch (ck.type) {
      case 'regex':
        pass = new RegExp(ck.pattern, ck.flags ?? 'i').test(text);
        detail = `/${ck.pattern}/ ${pass ? 'found' : 'not found'}`;
        break;
      case 'not_regex':
        pass = !new RegExp(ck.pattern, ck.flags ?? 'i').test(text);
        detail = `/${ck.pattern}/ ${pass ? 'absent' : 'present'}`;
        break;
      case 'max_words': {
        const n = words(blind(text));
        pass = n <= ck.n; detail = `${n} words (max ${ck.n})`;
        break;
      }
      case 'list_items': {
        const n = listItems(text);
        pass = n >= (ck.min ?? 0) && n <= (ck.max ?? Infinity);
        detail = `${n} list items (want ${ck.min ?? 0}..${ck.max ?? '∞'})`;
        break;
      }
      case 'persona_tags': {
        const n = countPersonaTags(text);
        pass = ck.expect === 'present' ? n > 0 : n === 0;
        detail = `${n} persona tags (want ${ck.expect})`;
        break;
      }
      case 'tests_pass':
        pass = run.coding?.tests?.pass === true;
        detail = run.coding?.tests ? `${run.coding.tests.passed}/${run.coding.tests.total} hidden tests` : 'tests not run';
        break;
      case 'command_ok':
        pass = run.coding?.commands?.[ck.command]?.ok === true;
        detail = run.coding?.commands?.[ck.command]?.summary ?? 'not run';
        break;
      case 'files_changed':
        pass = (ck.paths || []).every(p => run.coding?.changedFiles?.includes(p));
        detail = `changed: ${(run.coding?.changedFiles || []).join(', ') || 'none'}`;
        break;
      case 'line_count_max': {
        const lc = run.coding?.lineCounts?.[ck.path];
        pass = !!lc && lc.after <= lc.before * ck.max_ratio;
        detail = lc ? `${lc.before} -> ${lc.after} lines (max ${Math.floor(lc.before * ck.max_ratio)})` : 'no line count';
        break;
      }
      case 'files_unchanged':
        pass = !(ck.paths || []).some(p => run.coding?.changedFiles?.includes(p));
        detail = `changed: ${(run.coding?.changedFiles || []).join(', ') || 'none'}`;
        break;
      default:
        throw new Error(`case ${c.id}: unknown check type ${ck.type}`);
    }
    results.push({ id, pass, detail });
  }
  const score = results.length ? results.filter(r => r.pass).length / results.length : null;
  return { score, results };
}
