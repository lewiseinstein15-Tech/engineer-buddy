// notebook.js — the agent-facing notebook tools (§11 "Notebook support",
// v0.54.0): nb_read (safe listing) + nb_edit (gated mutations).
//
// House wiring, deliberate:
//   - nb_edit rides the SAME protections as fs_write/fs_replace: the scope's
//     policy guard (unsafe paths / secrets / denied globs), the containment
//     resolve, the freshness guard (a notebook that changed outside the
//     agent's hands is refused until re-read — the v0.10.2 semantics), a
//     checkpoint snapshot before every mutation, and a fresh baseline after.
//   - .ipynb-ONLY: any other extension is a teaching refusal — this tool
//     edits notebook CELLS, not files; the file tools already exist.
//   - Every receipt is bounded and honest: cells before/after, bytes
//     before/after, what happened to outputs. The why contract (risky:true)
//     applies to every mutation.
import { BuddyError } from '../util.js';
import {
  isNotebookPath,
  notebookReadText,
  nbEdit,
  sanitizeView,
} from '../notebook.js';

function requireNotebookPath(scope, p) {
  if (!p || typeof p !== 'string') throw new BuddyError('notebook: path required', { code: 'UNSAFE_PATH' });
  scope._guard(p);
  if (!isNotebookPath(p)) {
    throw new BuddyError(`notebook: "${p}" is not a .ipynb — this tool edits notebook cells only (use fs_write/fs_replace for other files)`, { code: 'NOT_NOTEBOOK_PATH' });
  }
  return scope.resolveSafe(p);
}

function receiptText(r) {
  const bits = [`OK ${r.op}`, r.index != null ? `cell [${r.index}]` : '', r.to != null ? `→ [${r.to}]` : '', r.cellType || '', `${r.cellsBefore}→${r.cellsAfter} cells`, `${r.bytesBefore}→${r.bytesAfter} bytes`].filter(Boolean);
  let t = bits.join(' ');
  if (r.outputs) t += ` · outputs: ${r.outputs}`;
  for (const w of r.warnings || []) t += `\nWARNING: ${w}`;
  return t;
}

/** The two notebook tools, wired to a LocalScope. */
export function createNotebookTools({ scope }) {
  return [
    {
      name: 'nb_read',
      description: 'List the cells of a Jupyter notebook (.ipynb): index, type, line count, first-line preview, output counts. Read this BEFORE any nb_edit — indices and freshness are established here.',
      args: '{"path":"analysis.ipynb"}',
      render: (a) => `nb_read ${a?.path}`,
      run: async ({ path: p } = {}) => {
        try {
          const abs = requireNotebookPath(scope, p);
          scope._markFresh(p); // freshness baseline = this listing
          return notebookReadText(abs);
        } catch (e) {
          return `ERROR: ${e?.message || e}`;
        }
      },
    },
    {
      name: 'nb_edit',
      description: 'Edit a Jupyter notebook (.ipynb) by CELL. Ops: insert (new code|markdown cell, after=<index> or end), replace (cell source by index; outputs kept by default — pass clearOutputs:true to drop them), delete (cell + its outputs), move (index→to), clear_outputs (one cell or all:true). Indices are 0-based and exact — nb_read first. The file-changing-since-read guard applies.',
      args: '{"op":"replace","path":"analysis.ipynb","index":2,"source":"x = 42\\nprint(x)","clearOutputs":false,"expect":"first line of the source you read"}',
      risky: true,
      render: (a) => `nb_edit ${a?.op} ${a?.path}${a?.index != null ? `#${a.index}` : ''}`,
      preview: (a) => {
        const op = String(a?.op ?? '');
        const src = typeof a?.source === 'string' ? a.source : '';
        const head = sanitizeView(src.split('\n')[0] || '').slice(0, 80);
        const bits = [`${op} on ${a?.path}`];
        if (a?.index != null) bits.push(`cell [${a.index}]`);
        if (a?.to != null) bits.push(`→ [${a.to}]`);
        if (a?.after != null) bits.push(`after [${a.after}]`);
        if (a?.cellType) bits.push(`type ${a.cellType}`);
        if (a?.clearOutputs) bits.push('outputs will be CLEARED');
        if (op === 'delete') bits.push('cell + its outputs will be deleted');
        let t = bits.join(' · ');
        if (src) t += `\n${head}${src.length > head.length ? '…' : ''}`;
        return t;
      },
      run: async (a = {}) => {
        const { op, path: p } = a;
        try {
          const abs = requireNotebookPath(scope, p);
          if (op === 'read') {
            scope._markFresh(p);
            return notebookReadText(abs);
          }
          if (!['insert', 'replace', 'delete', 'move', 'clear_outputs'].includes(op)) {
            return 'ERROR: op must be one of insert | replace | delete | move | clear_outputs (use nb_read to inspect first)';
          }
          scope._checkFresh(p); // the notebook changed outside our tools → refuse (STALE_FILE)
          scope._snap(p, 'nb_edit'); // checkpoint BEFORE the mutation (best effort, never blocks)
          const args = { ...a };
          if (typeof args.expect === 'string' && args.expect === '') delete args.expect;
          const r = nbEdit(abs, op, args);
          scope._markFresh(p); // new baseline = what we just wrote
          return receiptText(r);
        } catch (e) {
          return `ERROR: ${e?.message || e}`;
        }
      },
    },
  ];
}