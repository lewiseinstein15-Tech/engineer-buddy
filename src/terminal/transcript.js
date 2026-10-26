// transcript.js — the ctrl+r transcript viewer (v0.31.0).
//
// Claude Code's ctrl+r binding opens the full session transcript without
// killing the running turn. This module is the pure half of that feature:
//
//   capture  — sanitizeChunk(): every scrollback byte the mini-Ink renderer
//              prints already flows through renderer.print(); the box feeds
//              the same text here, keeps SGR color (the transcript looks
//              exactly like the live stream) and strips everything that
//              would corrupt a re-render (cursor moves, OSC, lone ESC, \r).
//   browse   — applyViewerKey(): the viewer's own key reducer. While the
//              viewer is open the editor is inert — no key can mutate the
//              draft, interrupt the turn, or quit the session (ctrl+c and
//              esc just close the pager).
//   paint    — buildTranscriptPanel(): the Aurora-styled panel. Pure
//              state → string[], painted by buildFrame so the spin timer
//              animates it and live-tails new lines while a turn streams.
//
// Degradation follows the Aurora contract: the captured lines carry their
// own color; the chrome (borders, header, footer) paints through SEM, so
// /theme mono degrades the whole panel automatically.

import { strWidth, wrapContent, truncateAnsi } from './text.js';
import { SEM } from './theme.js';

// Buffer + viewport limits. The buffer caps memory (a long session prints
// thousands of lines); the viewport caps the panel height so the renderer's
// erase-up math can never run past the top of the screen and ghost scrollback.
export const VIEWER = {
  MAX_BUFFER: 2000,
  MIN_BODY: 4,
  MAX_BODY: 30,
};

/** Body rows for a terminal of `rows` lines (panel chrome needs 4 more). */
export function viewerBodyRows(rows, cols = 80) {
  const term = Math.max(8, Number(rows) || 24);
  const body = term - 7;
  return Math.max(VIEWER.MIN_BODY, Math.min(VIEWER.MAX_BODY, body));
}

// ── Capture ──────────────────────────────────────────────────────────────────

/** Strip everything EXCEPT SGR color from a printed chunk. */
export function sanitizeAnsi(s) {
  let str = String(s ?? '');
  str = str.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''); // OSC … BEL / ST
  str = str.replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, '');          // CSI non-SGR (cursor moves, modes)
  str = str.replace(/\x1b(?!\[[0-9;?]*m)/g, '');                // lone ESC / private sequences
  str = str.replace(/\r\n/g, '\n').replace(/\r/g, '');          // ONLCR artifacts, progress redraws
  return str;
}

/** A printed chunk → transcript lines (SGR kept, no trailing blank). Pure. */
export function sanitizeChunk(chunk) {
  const clean = sanitizeAnsi(chunk);
  const lines = clean.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ── Browse: the viewer's own key reducer (pure, unit-tested) ────────────────
// While open, the viewer owns EVERY key: editing is inert, esc/ctrl+r/ctrl+c/q
// close, ↑↓ scroll by line, pgup/pgdn by page, g/G/home/end jump to the
// top/bottom (bottom = live tail again).

export function applyViewerKey(key = {}) {
  const name = key.name ?? '';
  const plain = !key.ctrl && !key.meta; // modifier chords are inert — only exact keys browse
  if (key.ctrl && name === 'c') return { action: 'close' };   // pager-first: never quit from the viewer
  if (key.ctrl && name === 'r') return { action: 'close' };   // ctrl+r toggles
  if (name === 'escape' || key.sequence === '\x1b') return { action: 'close' };
  if (plain && name === 'q') return { action: 'close' };
  if (plain && name === 'up') return { action: 'up' };
  if (plain && name === 'down') return { action: 'down' };
  if (plain && name === 'pageup') return { action: 'pageup' };
  if (plain && name === 'pagedown') return { action: 'pagedown' };
  if (plain && name === 'home') return { action: 'top' };
  if (plain && name === 'end') return { action: 'bottom' };
  if (plain && key.sequence === 'g') return { action: 'top' };
  if (plain && (key.sequence === 'G' || (name === 'g' && key.shift))) return { action: 'bottom' };
  return { action: null }; // inert: the draft and the running turn are untouchable
}

// ── Paint: the Aurora transcript panel (pure, unit-tested) ──────────────────
//
//   ╭─ ✦ transcript · 24 lines ──────────────────────── rows 8–12 of 12 ─╮
//   │ ❯ fix the cart discount bug                                       │
//   │ ▸ bash node cart.test.js ───────────────────────────────── 6ms    │
//   │ ⎿ ✓ exit 0 …                                                      │
//   ╰───────────────────────────────────────────────────────────────────╯
//     ↑↓ scroll · pgup/pgdn page · g/G top/bottom · esc close

/** Flatten logical lines into wrapped rows: [{ i, text }] — ANSI kept. Pure. */
function flattenRows(lines, width) {
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    for (const text of wrapContent(lines[i], width)) rows.push({ i, text });
  }
  return rows;
}

export function buildTranscriptPanel({ lines = [], cols = 80, rows = 12, scroll = 0, busy = null, tick = 0 } = {}) {
  const W = Math.min(Math.max(cols ?? 80, 34), 100);
  const body = Math.max(VIEWER.MIN_BODY, Math.min(VIEWER.MAX_BODY, Number(rows) || 12));
  const inner = W - 6; // between `│ ` and ` │` — 6 columns of chrome (same as the box's CW)
  const out = [];
  void tick;

  const all = flattenRows(Array.isArray(lines) ? lines : [], inner);
  const maxScroll = Math.max(0, all.length - body);
  const up = Math.max(0, Math.min(Number(scroll) || 0, maxScroll));
  const end = all.length - up;
  const start = Math.max(0, end - body);
  const win = all.slice(start, end);

  // header: title + line count, right-aligned visible-range
  const count = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
  const range = all.length ? (up === 0 ? 'live tail' : `↑ ${up}/${all.length}`) : 'empty';
  const rangeTxt = `${range} `;
  const dash = Math.max(1, W - 24 - count.length - range.length); // header total = W exactly
  out.push(`  ${'╭'}${SEM.time('─')} ${SEM.brand('✦')}${SEM.narrate(' transcript')} ${SEM.time(`· ${count} `)}${SEM.time('─'.repeat(dash))} ${SEM.time(rangeTxt)}${'╮'}`);

  // body
  if (!all.length) {
    const note = truncateAnsi(SEM.time('nothing yet — Buddy\'s work lands here as it happens'), inner);
    out.push(`  │ ${note}${' '.repeat(Math.max(0, inner - strWidth(note)))} │`);
  } else {
    for (const r of win) {
      const t = truncateAnsi(r.text, inner);
      const pad = Math.max(0, inner - strWidth(t));
      out.push(`  │ ${t}${' '.repeat(pad)} │`);
    }
    for (let i = win.length; i < body; i++) {
      out.push(`  │ ${' '.repeat(inner)} │`);
    }
  }

  // bottom border + footer hint
  out.push(`  ${SEM.time('╰' + '─'.repeat(Math.max(1, W - 4)) + '╯')}`);
  let hint = '↑↓ scroll · pgup/pgdn page · g/G top/bottom · esc close';
  if (busy) hint += ` · ${SEM.warn('turn still running')}`;
  out.push(`  ${SEM.time(truncateAnsi(hint, W - 2))}`);

  // never let a line wrap — same ghost-box killer as buildFrame
  return out.map((l) => (strWidth(l) > W ? truncateAnsi(l, W) : l));
}
