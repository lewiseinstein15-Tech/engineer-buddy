// rewind.js — the double-esc rewind menu (v0.32.0).
//
// Claude Code's double-esc opens the checkpoint rewind menu. Buddy already
// had the store (v0.9.7: every fs_write/fs_replace/fs_append snapshots its
// target to .buddy/checkpoints/ before the edit) and the command (/rewind),
// but nothing on the keyboard: you had to remember the command and the
// number. This module is the pure half of the menu:
//
//   chord   — isDoubleEscape(): two CONSECUTIVE escapes inside the window.
//             Any other keypress disarms (the box feeds timestamps in ctx so
//             the reducer stays pure); a palette or question-mode escape
//             never arms.
//   browse  — applyRewindMenuKey(): while the menu is open it owns every key.
//             ↑↓/k/j move, enter confirms, esc/ctrl+c/q close, everything
//             else inert — the draft, the session and a pending question are
//             untouchable from inside the menu.
//   paint   — buildRewindMenu(): the Aurora-styled panel over the box, same
//             chrome contract as the ctrl+r transcript panel (v0.31.0):
//             inner width = W - 6, every row ≤ W, SEM-painted so /theme mono
//             degrades the whole panel automatically.
//
// The impure half lives in inputbox.js (state + key routing) and repl.js
// (checkpoint list + restore, reusing the /rewind semantics: newest = 1,
// each restore is ONE undo — the applied manifest is consumed).

import { strWidth, truncateAnsi } from './text.js';
import { SEM } from './theme.js';
import { c } from './ui.js';

export const REWIND = {
  DOUBLE_ESC_MS: 1000, // two escapes within this window open the menu
  MAX_SHOW: 7,         // sliding window over the checkpoint list (palette parity)
};

/** Two consecutive escapes inside the window? Pure. */
export function isDoubleEscape(lastEscapeAt, now, ms = REWIND.DOUBLE_ESC_MS) {
  const t = Number(lastEscapeAt) || 0;
  if (!t) return false;
  const n = Number(now) || 0;
  return n >= t && n - t <= ms;
}

// ── Browse: the menu's own key reducer (pure, unit-tested) ──────────────────

export function applyRewindMenuKey(key = {}) {
  const name = key.name ?? '';
  const plain = !key.ctrl && !key.meta; // modifier chords are inert — only exact keys navigate
  if (key.ctrl && name === 'c') return { action: 'close' }; // menu-first: never quit from the menu
  if (name === 'escape' || key.sequence === '\x1b') return { action: 'close' };
  if (plain && name === 'q') return { action: 'close' };
  if (plain && name === 'up') return { action: 'up' };
  if (plain && name === 'down') return { action: 'down' };
  if (plain && key.sequence === 'k') return { action: 'up' };   // vim taste
  if (plain && key.sequence === 'j') return { action: 'down' };
  if (plain && (name === 'return' || name === 'enter')) return { action: 'confirm' };
  return { action: null }; // inert: nothing else gets through the menu
}

// ── Paint: the Aurora rewind panel (pure, unit-tested) ──────────────────────
//
//   ╭─ ✦ rewind · 3 checkpoints ───────────────────── files only · chat stays ─╮
//   │ ❯  1  09:14:03  fs_replace  src/cart.js                                 │
//   │    2  09:13:58  fs_write     cart.test.js                               │
//   ╰──────────────────────────────────────────────────────────────────────────╯
//     ↑↓ select · enter restore · esc close · one undo per restore

export function buildRewindMenu({ entries = [], sel = 0, cols = 80 } = {}) {
  const W = Math.min(Math.max(cols ?? 80, 34), 100);
  const inner = W - 6; // between `│ ` and ` │` — 6 columns of chrome (the v0.31.0 lesson)
  const list = Array.isArray(entries) ? entries : [];
  const out = [];

  // header: title + count, right-aligned safety note — total width = W exactly
  const count = `${list.length} checkpoint${list.length === 1 ? '' : 's'}`;
  const right = 'files only · chat stays '; // trailing space mirrors the transcript panel's `╮` padding
  const left = `─ ✦ rewind · ${count} `;
  const dash = Math.max(1, (W - 5) - strWidth(left) - strWidth(right));
  out.push(`  ╭${SEM.time(left)}${SEM.time('─'.repeat(dash))} ${SEM.time(right)}╮`);

  // body: a sliding window over the checkpoints, newest first (= /rewind numbering)
  if (!list.length) {
    const note = truncateAnsi(SEM.time('no checkpoints yet — Buddy snapshots every file before editing it'), inner);
    out.push(`  │ ${note}${' '.repeat(Math.max(0, inner - strWidth(note)))} │`);
  } else {
    const maxShow = Math.min(REWIND.MAX_SHOW, list.length);
    const selN = Math.max(0, Math.min(Number(sel) || 0, list.length - 1));
    let start = 0;
    if (list.length > maxShow) start = Math.max(0, Math.min(selN - 3, list.length - maxShow));
    const win = list.slice(start, start + maxShow);
    for (let i = 0; i < win.length; i++) {
      const abs = start + i;
      const ck = win[i];
      const time = String(ck.time || '').slice(11, 19) || '--:--:--';
      const tool = String(ck.tool || '?').slice(0, 10).padEnd(10);
      const files = (ck.files || []).map((f) => f.path).join(', ');
      const marker = abs === selN ? SEM.narrate('❯') : ' ';
      // narrow panels drop the time column so the paths keep real room —
      // the index (the /rewind number) and the tool always stay
      const content = inner < 40
        ? truncateAnsi(`${marker} ${c.bold(String(abs + 1).padStart(2))} ${tool} ${truncateAnsi(files, Math.max(0, inner - 16))}`, inner)
        : truncateAnsi(`${marker} ${c.bold(String(abs + 1).padStart(2))}  ${time}  ${tool}  ${truncateAnsi(files, Math.max(0, inner - 28))}`, inner);
      const row = `  │ ${content}${' '.repeat(Math.max(0, inner - strWidth(content)))} │`;
      out.push(abs === selN ? c.inverse(row) : row);
    }
  }

  // bottom border + footer hint
  out.push(`  ${SEM.time('╰' + '─'.repeat(Math.max(1, W - 4)) + '╯')}`);
  out.push(`  ${SEM.time(truncateAnsi('↑↓ select · enter restore · esc close · one undo per restore', W - 2))}`);

  // never let a line wrap — same ghost-box killer as buildFrame
  return out.map((l) => (strWidth(l) > W ? truncateAnsi(l, W) : l));
}
