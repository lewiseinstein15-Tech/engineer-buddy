// text.js — pure, unit-testable terminal text measurement (zero dependencies).
//
// Every visual width question in the TUI goes through here:
//   - ANSI escape codes are invisible (stripped before measuring)
//   - CJK / Hangul / fullwidth characters occupy 2 terminal columns
//   - rows() counts how many SCREEN rows a block occupies after wrapping —
//     this is the number the renderer erases; under-counting it is what
//     ghosted the v0.5.x box.

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s) {
  return String(s ?? '').replace(ANSI_RE, '');
}

export function charWidth(ch) {
  const code = ch.codePointAt(0);
  if (code === undefined) return 0;
  // CJK Unified Ideographs + extensions, Hiragana/Katakana, Hangul, fullwidth forms
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) return 2;
  return 1;
}

export function strWidth(s) {
  return stripAnsi(s).split('').reduce((w, ch) => w + charWidth(ch), 0);
}

// Greedy word wrap that degrades to hard-break for overlong words.
export function wrapContent(text, cols) {
  const out = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    if (rawLine === '') { out.push(''); continue; }
    let line = '';
    for (const word of rawLine.split(/(?<= )/)) { // keep trailing spaces with their word
      const candidate = line + word;
      if (strWidth(candidate) <= cols || line === '') {
        if (strWidth(candidate) <= cols) { line = candidate; continue; }
        // single overlong word: hard-break
        let rest = word;
        while (strWidth(rest) > cols) {
          let piece = ''; let w = 0; let i = 0;
          for (const ch of rest) {
            const cw = charWidth(ch);
            if (w + cw > cols) break;
            piece += ch; w += cw; i += ch.length;
          }
          out.push(piece);
          rest = rest.slice(i);
        }
        line = rest;
        continue;
      }
      out.push(line.replace(/\s+$/, ''));
      line = word;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

/** Screen rows a text block occupies after wrapping at `cols`. */
export function rowCount(text, cols) {
  let n = 0;
  for (const line of String(text ?? '').split('\n')) {
    n += Math.max(1, Math.ceil(strWidth(line) / Math.max(1, cols)));
  }
  return n;
}

/** Hard-cut a styled string to `max` visible columns, ANSI codes preserved. */
export function truncateAnsi(s, max) {
  const str = String(s ?? '');
  if (strWidth(str) <= max) return str;
  let out = '';
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\x1b') {
      const m = str.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
    }
    if (w >= max - 1) break;
    out += str[i];
    w += charWidth(str[i]);
  }
  return out + '…';
}

// ── Multi-line text math (v0.33.0) ───────────────────────────────────────────
// The input box learned newlines (ctrl+j / alt+enter). Every cursor question
// on a multi-line draft goes through these pure helpers — the box's old
// wrapped-cursor math subtracted only VISIBLE widths and desynced by one
// column per newline (a \n costs an index but occupies zero columns).

/** Start index of every logical line. `['ab', 'cd']` → [0, 3]. */
export function lineStarts(text) {
  const s = String(text ?? '');
  const starts = [0];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Absolute index → { line, col } (0-based). Pure. */
export function posToLineCol(text, pos) {
  const s = String(text ?? '');
  const p = Math.max(0, Math.min(Number(pos) || 0, s.length));
  const starts = lineStarts(s);
  let line = 0;
  for (let i = 0; i < starts.length; i++) {
    if (p >= starts[i]) line = i;
    else break;
  }
  return { line, col: p - starts[line] };
}

/** { line, col } → absolute index. Clamped to the text. Pure. */
export function lineColToPos(text, line, col) {
  const s = String(text ?? '');
  const starts = lineStarts(s);
  const li = Math.max(0, Math.min(Number(line) || 0, starts.length - 1));
  const lineEnd = li + 1 < starts.length ? starts[li + 1] - 1 : s.length; // before the \n
  const c = Math.max(0, Number(col) || 0);
  return Math.min(starts[li] + c, lineEnd);
}

/** Caret one visual line up; already on the first line → null (caller decides:
 *  the box recalls history there, matching Claude Code's up-at-top rule). */
export function caretUp(text, cursor) {
  const s = String(text ?? '');
  const { line, col } = posToLineCol(s, cursor);
  if (line === 0) return null;
  return lineColToPos(s, line - 1, col);
}

/** Caret one visual line down; already on the last line → null. */
export function caretDown(text, cursor) {
  const s = String(text ?? '');
  const { line, col } = posToLineCol(s, cursor);
  if (line >= lineStarts(s).length - 1) return null;
  return lineColToPos(s, line + 1, col);
}
