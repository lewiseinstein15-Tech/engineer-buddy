// notebook.js — Jupyter notebook (.ipynb) cell machinery for the nb_edit
// tool (§11 "Notebook support", v0.54.0). Zero deps; the notebook is DATA.
//
// The contract, in house voice:
//   - PATH POLICY lives in the callers (LocalScope for the agent tool, the
//     CLI for the command). The engine only ever sees an ABS path it was
//     given and never resolves paths itself beyond using it verbatim.
//   - BROKEN INPUT IS A REFUSAL, not a best-effort mangle: a file that does
//     not parse, has no cells array, or blows the size caps is refused with
//     an honest error and ZERO bytes written (atomic tmp+rename discipline).
//   - INDICES ARE CANONICAL OR REFUSED: 0-based integers, no coercion —
//     "1.5", "-1", "1e2", NaN, "" are teaching errors (the v0.50/v0.51
//     knob lessons). The engine never guesses which cell you meant.
//   - OUTPUTS BELONG TO THE CODE THAT MADE THEM: replace keeps outputs by
//     default (Jupyter semantics — they survive until re-run) but the
//     receipt says they are STALE in plain English; clear_outputs or
//     clearOutputs:true drops them honestly. delete takes them with the
//     cell — they live inside it.
//   - VIEWS ARE SANITIZED, DATA IS NOT: ANSI/OSC/control bytes in cell
//     source are stripped from every human-facing listing (the v0.52
//     lesson) while the bytes on disk stay exactly what the author wrote.
//   - WRITES ARE ATOMIC: temp file + rename, so a crash mid-write leaves
//     either the old notebook or the new one — never a torn hybrid.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BuddyError } from './util.js';

export const MAX_NB_BYTES = 16 * 1024 * 1024; // a notebook bigger than this is a data leak, not a notebook
export const MAX_CELL_BYTES = 200_000; // one cell's source cap — giants are refused, not truncated
export const MAX_CELLS = 2000; // catalog padding ends at the notebook border too
export const WRITABLE_CELL_TYPES = ['code', 'markdown'];

/** A .ipynb path check for the callers' policy layers. */
export function isNotebookPath(p) {
  return String(p || '').toLowerCase().endsWith('.ipynb');
}

/** Strip ANSI/OSC/control bytes for HUMAN-FACING views only (v0.52 lesson).
 *  Disk bytes are data and are never touched by this. The sequence forms are
 *  matched FIRST and the bare-ESC char class excludes \u001B — otherwise the
 *  char class eats the ESC byte and the sequence body survives as text. */
export function sanitizeView(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))|[\u0000-\u001A\u001C-\u001F\u007F]/g, '');
}

/** Canonical 0-based index or a teaching refusal. Accepts a real integer or
 *  an EXACT plain decimal integer string — nothing else (the knob-coercion
 *  lesson: no trim, no sign games, no float flirtation — junk is refused). */
export function parseIndex(v, what = 'index') {
  const s = typeof v === 'number' ? String(v) : String(v ?? '');
  if (!/^\d+$/.test(s)) {
    throw new BuddyError(`notebook: ${what} must be a 0-based integer (got ${JSON.stringify(v)})`, { code: 'BAD_INDEX' });
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new BuddyError(`notebook: ${what} out of range: ${s}`, { code: 'BAD_INDEX' });
  }
  return n;
}

/** nbformat source → plain string. Accepts the string form or the array of
 *  lines form (each line usually ends with \n except possibly the last). */
export function sourceText(src) {
  if (typeof src === 'string') return src;
  if (Array.isArray(src)) return src.map((l) => (typeof l === 'string' ? l : String(l))).join('');
  return '';
}

/** Plain text → nbformat array-of-lines: "a\nb" → ["a\n","b"], "a\n" → ["a\n"],
 *  "a" → ["a"]. Splitting happens on \n only; \r stays in the data (Windows
 *  round-trips keep their bytes until an explicit normalization is asked for). */
export function normalizeSource(text) {
  const s = String(text ?? '');
  if (s === '') return [];
  const parts = s.split('\n');
  const lines = parts.slice(0, -1).map((l) => l + '\n');
  const last = parts[parts.length - 1];
  if (last !== '') lines.push(last); // trailing \n is implicit, not stored
  return lines;
}

/** Load + validate a notebook. Honest refusals: NO_FILE, IS_DIR, TOO_LARGE,
 *  BAD_JSON (with the parser's own position), NOT_NOTEBOOK (parses but has
 *  no cells array). Returns { nb, bytes, raw }. */
export function loadNotebook(abs, { maxBytes = MAX_NB_BYTES } = {}) {
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new BuddyError(`notebook: file not found: ${abs}`, { code: 'NO_FILE' });
  }
  if (st.isDirectory()) {
    throw new BuddyError(`notebook: ${abs} is a directory, not a notebook`, { code: 'IS_DIR' });
  }
  if (st.size > maxBytes) {
    throw new BuddyError(`notebook: ${abs} is ${(st.size / 1024 / 1024).toFixed(1)}MB — over the ${Math.round(maxBytes / 1024 / 1024)}MB read cap; open it in Jupyter`, { code: 'TOO_LARGE' });
  }
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    throw new BuddyError(`notebook: cannot read ${abs} — ${e?.message || e}`, { code: 'NO_FILE' });
  }
  let nb;
  try {
    nb = JSON.parse(raw);
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 200);
    throw new BuddyError(`notebook: ${abs} is not valid JSON — ${msg}. A torn notebook is refused, never repaired by guesswork.`, { code: 'BAD_JSON' });
  }
  if (!nb || typeof nb !== 'object' || Array.isArray(nb) || !Array.isArray(nb.cells)) {
    throw new BuddyError(`notebook: ${abs} parses as JSON but has no cells array — not a Jupyter notebook this tool will touch`, { code: 'NOT_NOTEBOOK' });
  }
  // every cell must be a cell OBJECT — junk (numbers, strings, nulls) is
  // refused here, not crashed on later mid-mutation
  for (let i = 0; i < nb.cells.length; i++) {
    const c = nb.cells[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new BuddyError(`notebook: ${abs} has a malformed cell — cells[${i}] is ${c === null ? 'null' : Array.isArray(c) ? 'an array' : typeof c}, not a cell object. Refused, never repaired by guesswork.`, { code: 'NOT_NOTEBOOK' });
    }
  }
  return { nb, bytes: Buffer.byteLength(raw, 'utf8'), raw };
}

/** Serialize the nbformat-standard way: indent 1, one trailing newline. */
export function serializeNotebook(nb) {
  return JSON.stringify(nb, null, 1) + '\n';
}

/** A bounded, control-byte-sanitized English listing of the notebook's cells. */
export function notebookReadText(abs, { maxCells = 200, maxPreview = 96 } = {}) {
  const { nb, bytes } = loadNotebook(abs);
  const fmt = `nbformat ${nb.nbformat ?? '?'}.${nb.nbformat_minor ?? '?'}`;
  const lines = [
    `NOTEBOOK ${abs}`,
    `${fmt} · ${nb.cells.length} cell${nb.cells.length === 1 ? '' : 's'} · ${(bytes / 1024).toFixed(1)} KB`,
    ...(nb.metadata && nb.metadata.kernelspec?.name ? [`kernel: ${sanitizeView(nb.metadata.kernelspec.name)}`] : []),
    '-'.repeat(64),
  ];
  const n = Math.min(nb.cells.length, maxCells);
  for (let i = 0; i < n; i++) {
    const c = nb.cells[i];
    const src = sourceText(c.source);
    const first = sanitizeView(src.split('\n')[0] || '(empty cell)').slice(0, maxPreview);
    const nlines = src === '' ? 0 : (src.endsWith('\n') ? src.slice(0, -1) : src).split('\n').length;
    const outs = c.cell_type === 'code' ? ` · outputs ${Array.isArray(c.outputs) ? c.outputs.length : 0}${c.execution_count != null ? ` · exec ${c.execution_count}` : ''}` : '';
    lines.push(`[${String(i).padStart(3)}] ${c.cell_type}${outs} · ${nlines}L · ${first}`);
  }
  if (nb.cells.length > n) lines.push(`… +${nb.cells.length - n} more cells (view capped at ${maxCells} — the notebook is untouched)`);
  return lines.join('\n');
}

function ensureCellCap(nb, extra = 0) {
  if (nb.cells.length + extra > MAX_CELLS) {
    throw new BuddyError(`notebook: ${nb.cells.length} cells + ${extra} would cross the ${MAX_CELLS}-cell cap — split the notebook`, { code: 'CELL_CAP' });
  }
}

function checkCellBytes(source) {
  const n = Buffer.byteLength(String(source), 'utf8');
  if (n > MAX_CELL_BYTES) {
    throw new BuddyError(`notebook: cell source is ${n} bytes — over the ${MAX_CELL_BYTES}-byte per-cell cap`, { code: 'CELL_TOO_BIG' });
  }
}

function requireCell(nb, index, what = 'index') {
  const i = parseIndex(index, what);
  if (i >= nb.cells.length) {
    throw new BuddyError(`notebook: ${what} ${i} is out of range — the notebook has ${nb.cells.length} cell${nb.cells.length === 1 ? '' : 's'} (0..${nb.cells.length - 1})`, { code: 'BAD_INDEX' });
  }
  return i;
}

function checkExpect(nb, index, expect) {
  if (expect == null || String(expect) === '') return; // optional guard
  const current = sourceText(nb.cells[index].source);
  const want = String(expect);
  const head = current.slice(0, want.length);
  if (head !== want) {
    throw new BuddyError(
      `notebook: cell [${index}] is stale — its source no longer starts with the expected text (someone changed it since you read it). Re-read the notebook and retry with the fresh source.`,
      { code: 'STALE_CELL' }
    );
  }
}

/** Atomic write: temp file in the same directory + rename. A crash leaves
 *  the old notebook or the new one — never a torn hybrid. */
function atomicWrite(abs, nb) {
  const text = serializeNotebook(nb);
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.nbtmp-${randomUUID().slice(0, 8)}`);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw new BuddyError(`notebook: write failed honestly — ${e?.message || e} (the original notebook is untouched)`, { code: 'WRITE_FAILED' });
  }
}

/** One mutation, end to end: load → validate → mutate → atomic write → receipt.
 *  Ops: insert | replace | delete | move | clear_outputs. */
export function nbEdit(abs, op, args = {}, opts = {}) {
  const { nb, bytes: bytesBefore } = loadNotebook(abs, opts);
  const cellsBefore = nb.cells.length;
  const base = { op, path: abs, cellsBefore };
  let warnings = [];

  if (op === 'insert') {
    const cellType = String(args.cellType ?? args.cell_type ?? '').toLowerCase();
    if (!WRITABLE_CELL_TYPES.includes(cellType)) {
      throw new BuddyError(`notebook: insert needs cellType "code" or "markdown" (got ${JSON.stringify(args.cellType ?? null)})`, { code: 'BAD_TYPE' });
    }
    const source = args.source;
    if (typeof source !== 'string' || source === '') {
      throw new BuddyError('notebook: insert needs a non-empty source string', { code: 'BAD_SOURCE' });
    }
    checkCellBytes(source);
    ensureCellCap(nb, 1);
    let at = nb.cells.length; // default: end
    if (args.after != null && String(args.after) !== '') {
      const a = parseIndex(args.after, 'after');
      if (a >= nb.cells.length) {
        throw new BuddyError(`notebook: after ${a} is out of range — the notebook has ${nb.cells.length} cell${nb.cells.length === 1 ? '' : 's'}`, { code: 'BAD_INDEX' });
      }
      at = a + 1;
    }
    const cell = { cell_type: cellType, source: normalizeSource(source) };
    // id consistency (nbformat 4.5+): only when sibling cells carry ids
    if (nb.cells.length && nb.cells.every((c) => typeof c.id === 'string' && c.id)) {
      cell.id = `nbcell-${randomUUID().slice(0, 8)}`;
    }
    if (cellType === 'code') {
      cell.outputs = [];
      cell.execution_count = null;
    }
    nb.cells.splice(at, 0, cell);
    const text = serializeNotebook(nb);
    atomicWrite(abs, nb);
    return { ...base, index: at, cellType, cellsAfter: nb.cells.length, bytesBefore, bytesAfter: Buffer.byteLength(text, 'utf8'), outputs: cellType === 'code' ? 'none (fresh cell)' : undefined, warnings };
  }

  if (op === 'replace') {
    const i = requireCell(nb, args.index);
    if (typeof args.source !== 'string' || args.source === '') {
      throw new BuddyError('notebook: replace needs a non-empty source string', { code: 'BAD_SOURCE' });
    }
    checkCellBytes(args.source);
    checkExpect(nb, i, args.expect);
    const cell = nb.cells[i];
    if (args.cellType != null && String(args.cellType) !== '' && String(args.cellType).toLowerCase() !== cell.cell_type) {
      throw new BuddyError(
        `notebook: cell [${i}] is a ${cell.cell_type} cell — replace cannot flip its type (got ${JSON.stringify(args.cellType)}). Delete and insert instead.`,
        { code: 'BAD_TYPE' }
      );
    }
    const hadOutputs = cell.cell_type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0;
    const clearOutputs = Boolean(args.clearOutputs);
    cell.source = normalizeSource(args.source);
    if (clearOutputs && cell.cell_type === 'code') {
      cell.outputs = [];
      cell.execution_count = null;
    }
    // the disposition is decided from the PRE-clear state — clearing first
    // would report a dishonest 'none' (the drill's original catch). Markdown
    // cells have no outputs concept at all — no field, no noise.
    const disp = cell.cell_type !== 'code' ? undefined : clearOutputs ? (hadOutputs ? 'cleared' : 'none') : hadOutputs ? 'kept (stale — they belong to the previous source)' : 'none';
    if (disp && disp.startsWith('kept')) warnings.push('outputs kept — they belong to the previous source and will look fresh in Jupyter; clear_outputs or clearOutputs:true drops them');
    const text = serializeNotebook(nb);
    atomicWrite(abs, nb);
    return { ...base, index: i, cellType: cell.cell_type, cellsAfter: nb.cells.length, bytesBefore, bytesAfter: Buffer.byteLength(text, 'utf8'), outputs: disp, warnings };
  }

  if (op === 'delete') {
    const i = requireCell(nb, args.index);
    checkExpect(nb, i, args.expect);
    const [gone] = nb.cells.splice(i, 1); // its outputs live inside it — they go too
    const text = serializeNotebook(nb);
    atomicWrite(abs, nb);
    const dropped = gone && Array.isArray(gone.outputs) ? gone.outputs.length : 0;
    return { ...base, index: i, cellsAfter: nb.cells.length, bytesBefore, bytesAfter: Buffer.byteLength(text, 'utf8'), outputs: dropped > 0 ? `dropped ${dropped} output record${dropped === 1 ? '' : 's'} (they belonged to the deleted cell)` : 'none', warnings };
  }

  if (op === 'move') {
    const i = requireCell(nb, args.index);
    const to = parseIndex(args.to, 'to');
    if (to >= nb.cells.length) {
      throw new BuddyError(`notebook: to ${to} is out of range — the notebook has ${nb.cells.length} cell${nb.cells.length === 1 ? '' : 's'} (0..${nb.cells.length - 1})`, { code: 'BAD_INDEX' });
    }
    checkExpect(nb, i, args.expect);
    if (to === i) {
      return { ...base, index: i, to, cellsAfter: nb.cells.length, bytesBefore, bytesAfter: bytesBefore, moved: false, warnings: ['to === index — nothing moved, nothing written (honest no-op)'] };
    }
    const [cell] = nb.cells.splice(i, 1);
    nb.cells.splice(to, 0, cell);
    const text = serializeNotebook(nb);
    atomicWrite(abs, nb);
    return { ...base, index: i, to, cellsAfter: nb.cells.length, bytesBefore, bytesAfter: Buffer.byteLength(text, 'utf8'), moved: true, warnings };
  }

  if (op === 'clear_outputs') {
    if (args.all) {
      let cleared = 0;
      for (const c of nb.cells) {
        if (c.cell_type === 'code' && Array.isArray(c.outputs) && c.outputs.length) {
          c.outputs = [];
          c.execution_count = null;
          cleared++;
        }
      }
      const text = serializeNotebook(nb);
      atomicWrite(abs, nb);
      return { ...base, cellsAfter: nb.cells.length, bytesBefore, bytesAfter: Buffer.byteLength(text, 'utf8'), outputs: `cleared ${cleared} code cell${cleared === 1 ? '' : 's'}`, warnings };
    }
    const i = requireCell(nb, args.index);
    const c = nb.cells[i];
    if (c.cell_type !== 'code') {
      throw new BuddyError(`notebook: cell [${i}] is a ${c.cell_type} cell — it has no outputs to clear`, { code: 'NO_OUTPUTS' });
    }
    const had = Array.isArray(c.outputs) ? c.outputs.length : 0;
    c.outputs = [];
    c.execution_count = null;
    const text = serializeNotebook(nb);
    atomicWrite(abs, nb);
    return { ...base, index: i, cellsAfter: nb.cells.length, bytesBefore, bytesAfter: Buffer.byteLength(text, 'utf8'), outputs: had ? `cleared ${had} output record${had === 1 ? '' : 's'}` : 'none (already empty)', warnings };
  }

  throw new BuddyError(`notebook: unknown op "${op}" — known: insert | replace | delete | move | clear_outputs`, { code: 'BAD_OP' });
}
