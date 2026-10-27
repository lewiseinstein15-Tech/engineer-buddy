// vim.js — modal editing on the input line (v0.33.0): the pure half.
//
// Claude Code ships a vim mode; Buddy's checklist wanted one since v0.6
// (`/vim`: normal/insert, hjkl, dd/yy/p on the input line). The box already
// has the editing primitives — this module adds the MODAL GRAMMAR on top,
// as a pure reducer so every motion, operator and edge case is unit-testable
// without a terminal:
//
//   applyVimKey(key, st, text, cursor) →
//     { op: 'edit', st, text, cursor }   — an edit happened (box repaints)
//     { op: 'inert', st }                — key consumed, nothing changed
//     { action, st, data? }              — passthrough (submit/escape/sigint/
//                                          eof/newline/history/ctrl-chords);
//                                          the box runs its own switch so
//                                          vim never forks semantics
//
// Scope (honest): normal + insert, counts on motions and dd/yy/x, w/b/e
// word motions, x/X, D/C, o/O, i/a/I/A, p/P with charwise+linewise registers,
// gg/G, 0/$/^, cc. No marks, no search, no undo (`u`), no `.` repeat —
// the input line is one to a few lines long, not a document.
//
// Esc is MODAL here: insert→normal, normal→the box's classic escape
// (clear draft / interrupt). The double-esc rewind chord never arms from
// inside vim normal mode — vim's esc is a mode key, a chord would fire on
// everyday modal editing. Close menus, then leave insert; rewind opens
// when /vim is off.

import { lineStarts, posToLineCol, lineColToPos, caretUp, caretDown } from './text.js';

export function createVimState() {
  return { mode: 'normal', pending: null, count: '', reg: null };
}

// ── Word motions (vim word classes, simplified: wordchars vs punct runs) ────

const isWordChar = (ch) => /[A-Za-z0-9_]/.test(ch);
const cls = (ch) => (!ch || ch === '\n') ? 'nl' : /\s/.test(ch) ? 'ws' : isWordChar(ch) ? 'w' : 'p';

/** Start of the next word/run after index i (vim `w`). Clamped to length. */
export function wordRight(text, i) {
  const s = String(text ?? '');
  const n = s.length;
  let j = Math.max(0, Math.min(Number(i) || 0, n));
  if (j >= n) return n;
  const c0 = cls(s[j]);
  if (c0 !== 'nl' && c0 !== 'ws') { // leave the current run
    while (j < n && cls(s[j]) === c0) j++;
  }
  while (j < n && (cls(s[j]) === 'ws' || cls(s[j]) === 'nl')) j++; // cross blanks
  return j;
}

/** Start of the previous word/run before index i (vim `b`). */
export function wordBack(text, i) {
  const s = String(text ?? '');
  let j = Math.max(0, Math.min(Number(i) || 0, s.length));
  j = Math.max(0, j - 1);
  while (j > 0 && (cls(s[j]) === 'ws' || cls(s[j]) === 'nl')) j--;
  if (j === 0 && (cls(s[0]) === 'ws' || cls(s[0]) === 'nl')) return 0;
  const c0 = cls(s[j]);
  while (j > 0 && cls(s[j - 1]) === c0 && c0 !== 'ws' && c0 !== 'nl') j--;
  return j;
}

/** End of the current/next word run (vim `e`). Lands on the LAST char. */
export function wordEnd(text, i) {
  const s = String(text ?? '');
  const n = s.length;
  let j = Math.max(0, Math.min(Number(i) || 0, n));
  j = Math.min(j + 1, n - 1);
  while (j < n - 1 && (cls(s[j]) === 'ws' || cls(s[j]) === 'nl')) j++;
  if (j >= n) return Math.max(0, n - 1);
  const c0 = cls(s[j]);
  while (j < n - 1 && cls(s[j + 1]) === c0) j++;
  return j;
}

// ── Line helpers (the input line, not the file — \n-separated draft) ────────

function lineBounds(text, pos) {
  const starts = lineStarts(text);
  const { line } = posToLineCol(text, pos);
  const start = starts[line];
  const end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length; // before the \n
  return { starts, line, start, end };
}

function firstNonBlank(text, start, end) {
  for (let i = start; i < end; i++) {
    if (text[i] !== ' ' && text[i] !== '\t') return i;
  }
  return end;
}

function takeCount(st) {
  const n = parseInt(st.count || '1', 10);
  return Math.max(1, Math.min(999, Number.isFinite(n) ? n : 1));
}

const countOf = (st) => (st.count ? `${st.count}` : '');

// ── The reducer ──────────────────────────────────────────────────────────────

/**
 * One keypress in vim NORMAL mode. Pure: (key, st, text, cursor) → result.
 * Never mutates inputs. `key` is the node keypress shape.
 */
export function applyVimKey(key, stIn, text, cursor) {
  const st = { ...stIn, reg: stIn.reg ? { ...stIn.reg } : null };
  const s = String(text ?? '');
  let cur = Math.max(0, Math.min(Number(cursor) || 0, s.length));
  const name = key.name ?? '';
  const seq = key.sequence ?? '';
  const plain = !key.ctrl && !key.meta;

  // control chords pass through untouched — interrupt/eof/expand/viewer are
  // global affordances, vim never owns them
  if (key.ctrl && name === 'c') return { op: 'action', action: 'sigint', st };
  if (key.ctrl && name === 'd') return { op: 'action', action: 'eof', st };
  if (key.ctrl && name === 'o') return { op: 'action', action: 'verbose-toggle', st };
  if (key.ctrl && name === 'r') return { op: 'action', action: 'transcript', st };

  // escape is modal: normal-mode esc = the box's classic escape semantics
  if (name === 'escape' || seq === '\x1b') return { op: 'action', action: 'escape', st };

  // enter submits (draft may be multi-line — the box sends it as one task)
  if (plain && (name === 'return' || name === 'enter')) return { op: 'action', action: 'submit', st };

  // literal newline (ctrl+j = LF, alt+enter) — inserts like any edit
  if ((key.ctrl && name === 'j') || (key.meta && (name === 'return' || name === 'enter'))) {
    return { op: 'edit', st, text: s.slice(0, cur) + '\n' + s.slice(cur), cursor: cur + 1 };
  }

  if (!plain) return { op: 'inert', st }; // unknown modifier chord: consumed, inert

  // count prefix (0 is a motion when no count is building)
  if (/^[1-9]$/.test(seq) || (seq === '0' && st.count)) {
    if (st.count.length >= 3) return { op: 'inert', st };
    return { op: 'inert', st: { ...st, count: st.count + seq } };
  }

  // pending operator-second-key: dd / yy / cc
  if (st.pending) {
    const p = st.pending;
    st.pending = null;
    if (p === 'd' && seq === 'd') {
      const n = takeCount(st);
      const first = lineBounds(s, cur);
      const lastLine = Math.min(first.line + n - 1, first.starts.length - 1);
      const delStart = first.starts[first.line];
      const delEnd = lastLine + 1 < first.starts.length ? first.starts[lastLine + 1] : s.length; // include the trailing \n
      const regText = s.slice(delStart, delEnd).replace(/\n$/, '');
      const out = s.slice(0, delStart) + s.slice(delEnd);
      const nextStart = Math.min(delStart, out.length);
      return { op: 'edit', st: { ...st, count: '', reg: { text: regText, linewise: true } }, text: out, cursor: nextStart };
    }
    if (p === 'y' && seq === 'y') {
      const n = takeCount(st);
      const first = lineBounds(s, cur);
      const lastLine = Math.min(first.line + n - 1, first.starts.length - 1);
      const yStart = first.starts[first.line];
      const yEnd = lastLine + 1 < first.starts.length ? first.starts[lastLine + 1] - 1 : s.length;
      return { op: 'edit', st: { ...st, count: '', reg: { text: s.slice(yStart, yEnd), linewise: true } }, text: s, cursor: cur };
    }
    if (p === 'c' && seq === 'c') {
      const { start, end } = lineBounds(s, cur);
      const out = s.slice(0, start) + s.slice(end);
      return { op: 'edit', st: { ...st, count: '', mode: 'insert' }, text: out, cursor: start };
    }
    if (p === 'g' && seq === 'g') {
      return { op: 'edit', st: { ...st, count: '' }, text: s, cursor: 0 }; // gg — top of the draft
    }
    // any other key cancels the pending op and falls through as itself
  }

  // consume: default edit result. stExtra merges into the vim state; outExtra
  // overrides the returned top-level fields (text/cursor). Splitting them is
  // not cosmetic: motions pass { cursor: next } — if that landed in st the
  // box would read the OLD cursor and every 0/^/$/2w/a-I-A motion would
  // silently no-op (caught by the first test run).
  const consume = (stExtra = {}, outExtra = {}) => ({ op: 'edit', st: { ...st, count: '', pending: null, ...stExtra }, text: s, cursor: cur, ...outExtra });

  switch (seq || name) {
    case 'h':
    case 'left': {
      for (let k = 0; k < takeCount(st) && cur > 0; k++) cur--;
      return consume();
    }
    case 'l':
    case 'right':
    case ' ': {
      for (let k = 0; k < takeCount(st) && cur < s.length; k++) cur++;
      return consume();
    }
    case 'j':
    case 'down': {
      let next = cur;
      for (let k = 0; k < takeCount(st); k++) {
        const dn = caretDown(s, next);
        if (dn == null) break;
        next = dn;
      }
      if (next === cur) return { op: 'action', action: 'history-next', st: { ...st, count: '' } }; // last line: history
      return consume({}, { cursor: next });
    }
    case 'k':
    case 'up': {
      let next = cur;
      for (let k = 0; k < takeCount(st); k++) {
        const up = caretUp(s, next);
        if (up == null) break;
        next = up;
      }
      if (next === cur) return { op: 'action', action: 'history-prev', st: { ...st, count: '' } }; // first line: history
      return consume({}, { cursor: next });
    }
    case '0': return consume({}, { cursor: lineBounds(s, cur).start });
    case '^': { const { start, end } = lineBounds(s, cur); return consume({}, { cursor: firstNonBlank(s, start, end) }); }
    case '$': return consume({}, { cursor: Math.max(lineBounds(s, cur).start, lineBounds(s, cur).end - 1) });
    case 'w': {
      let next = cur;
      for (let k = 0; k < takeCount(st); k++) next = wordRight(s, next);
      return consume({}, { cursor: next });
    }
    case 'b': {
      let next = cur;
      for (let k = 0; k < takeCount(st); k++) next = wordBack(s, next);
      return consume({}, { cursor: next });
    }
    case 'e': {
      let next = cur;
      for (let k = 0; k < takeCount(st); k++) next = wordEnd(s, next);
      return consume({}, { cursor: next });
    }
    case 'g': return { op: 'inert', st: { ...st, pending: 'g', count: '' } }; // wait for the second g
    case 'G': return consume({}, { cursor: s.length });
    case 'x': {
      const n = takeCount(st);
      const cut = s.slice(cur, cur + n);
      if (!cut) return consume();
      return { op: 'edit', st: { ...st, count: '', pending: null }, text: s.slice(0, cur) + s.slice(cur + n), cursor: cur };
    }
    case 'X': {
      if (cur === 0) return consume();
      const n = Math.min(takeCount(st), cur);
      return { op: 'edit', st: { ...st, count: '', pending: null }, text: s.slice(0, cur - n) + s.slice(cur), cursor: cur - n };
    }
    case 'D': { const { end } = lineBounds(s, cur); return { op: 'edit', st: { ...st, count: '', pending: null }, text: s.slice(0, cur) + s.slice(end), cursor: cur }; }
    case 'C': { const { end } = lineBounds(s, cur); return { op: 'edit', st: { ...st, count: '', pending: null, mode: 'insert' }, text: s.slice(0, cur) + s.slice(end), cursor: cur }; }
    case 'd': return { op: 'inert', st: { ...st, pending: 'd', count: countOf(st) } };
    case 'y': return { op: 'inert', st: { ...st, pending: 'y', count: countOf(st) } };
    case 'c': return { op: 'inert', st: { ...st, pending: 'c', count: countOf(st) } };
    case 'p': {
      const reg = st.reg;
      if (!reg || !reg.text) return consume();
      const n = takeCount(st);
      if (reg.linewise) {
        const { starts, line } = lineBounds(s, cur);
        const at = line + 1 < starts.length ? starts[line + 1] : s.length; // line below (or EOF)
        const reps = Array.from({ length: n }, () => reg.text);
        if (at >= s.length) {
          // after the last line: append as new draft lines — an EMPTIED draft
          // gets just the register text (no stray leading/trailing newline)
          const sep = s.length ? '\n' : '';
          const out = s + sep + reps.join('\n');
          return { op: 'edit', st: { ...st, count: '', pending: null }, text: out, cursor: s.length + sep.length };
        }
        const out = s.slice(0, at) + reps.join('\n') + '\n' + s.slice(at);
        return { op: 'edit', st: { ...st, count: '', pending: null }, text: out, cursor: at };
      }
      const at = Math.min(cur + 1, s.length); // after the cursor (charwise)
      const block = Array.from({ length: n }, () => reg.text).join('');
      const out = s.slice(0, at) + block + s.slice(at);
      return { op: 'edit', st: { ...st, count: '', pending: null }, text: out, cursor: at + block.length - 1 };
    }
    case 'P': {
      const reg = st.reg;
      if (!reg || !reg.text) return consume();
      const n = takeCount(st);
      const reps = Array.from({ length: n }, () => reg.text);
      if (reg.linewise) {
        const { start } = lineBounds(s, cur);
        const out = s.slice(0, start) + reps.join('\n') + '\n' + s.slice(start);
        return { op: 'edit', st: { ...st, count: '', pending: null }, text: out, cursor: start };
      }
      const block = reps.join('');
      const out = s.slice(0, cur) + block + s.slice(cur);
      return { op: 'edit', st: { ...st, count: '', pending: null }, text: out, cursor: Math.max(0, cur + block.length - 1) };
    }
    case 'i': return consume({ mode: 'insert' });
    case 'a': return consume({ mode: 'insert' }, { cursor: Math.min(cur + 1, s.length) });
    case 'I': { const { start, end } = lineBounds(s, cur); return consume({ mode: 'insert' }, { cursor: firstNonBlank(s, start, end) }); }
    case 'A': { const { end } = lineBounds(s, cur); return consume({ mode: 'insert' }, { cursor: end }); }
    case 'o': {
      const { end } = lineBounds(s, cur);
      const out = s.slice(0, end) + '\n' + s.slice(end);
      return { op: 'edit', st: { ...st, count: '', pending: null, mode: 'insert' }, text: out, cursor: end + 1 };
    }
    case 'O': {
      const { start } = lineBounds(s, cur);
      const out = s.slice(0, start) + '\n' + s.slice(start);
      return { op: 'edit', st: { ...st, count: '', pending: null, mode: 'insert' }, text: out, cursor: start + 1 };
    }
    case '/': {
      // palette access from normal mode: seed the slash and switch to insert —
      // commands stay one keystroke away in vim too
      const out = `/${s}`;
      return { op: 'edit', st: { ...st, count: '', pending: null, mode: 'insert' }, text: out, cursor: 1 };
    }
    default:
      return { op: 'inert', st: { ...st, pending: null, count: '' } }; // unknown key: cancel pending, stay put
  }
}
