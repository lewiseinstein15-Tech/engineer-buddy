// inputbox.js — the Claude Code input panel, rebuilt on mini-Ink (v0.6).
//
// The v0.5.x box mixed readline, stdout patching and hand-tracked heights —
// three writers for one cursor. This version is the real model:
//
//   state ──▶ buildFrame(state, cols) ──▶ renderer.render()
//
// The box is a pure function of its state. Every keypress, spinner tick,
// resize or print rebuilds the frame from scratch and the renderer erases
// exactly the screen rows the previous frame occupied (wrap-aware, CJK-aware),
// so the box can never ghost, duplicate or scroll away.
//
// Signature Claude Code behaviours:
//   - bottom-anchored rounded box with `>` prompt and inverse block cursor
//   - `? shortcuts`-style footer, right-aligned version/gateway/ctx status
//   - busy footer: spinner glyph · label · "esc to interrupt · Ns"
//   - slash-command palette: typing `/` opens a highlighted menu above the
//     box; ↑↓ select, tab accepts, esc dismisses
//   - submitted lines are echoed into scrollback like Claude Code's `> msg`
//   - bracketed paste is unwrapped and pasted as one line
//   - ctrl+o (v0.30.0) toggles the expanded transcript: the Aurora strip's
//     narration grows to a 3-row mini transcript and tool observations
//     render in full (repl.js listens on the 'verbose' handler event)
//   - ctrl+r (v0.31.0) opens the session transcript viewer: a scrollable,
//     live-tailing panel over the box, fed by every byte the renderer prints
//     (renderer.print → onPrint → capture). Editing is inert while open; the
//     running turn keeps streaming into the tail.
//   - double-esc (v0.32.0) opens the rewind menu: two consecutive escapes
//     inside REWIND.DOUBLE_ESC_MS pop the checkpoint panel over the box —
//     ↑↓ pick, enter restores files to before that step (one undo), esc
//     closes. A palette or question-mode escape never arms the chord.

import fs from 'node:fs';
import readline from 'node:readline';
import { createRenderer } from './renderer.js';
import { c } from './ui.js';
import { buildAuroraStrip, SEM } from './theme.js';
import { charWidth, strWidth, wrapContent, truncateAnsi, lineStarts, posToLineCol, caretUp, caretDown } from './text.js';
import { sanitizeChunk, applyViewerKey, buildTranscriptPanel, viewerBodyRows, VIEWER } from './transcript.js';
import { isDoubleEscape, applyRewindMenuKey, buildRewindMenu } from './rewind.js';
import { createVimState, applyVimKey } from './vim.js';

export { charWidth, strWidth, wrapContent };

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Key reducer: maps a keypress to an editing action (pure, unit-tested).
// key: { name?, ctrl?, meta?, sequence? } — the node keypress event shape.
// ctx: { paletteOpen?, questionMode?, lastEscapeAt?, now? } — switches ↑/↓
// from history to palette navigation; lastEscapeAt+now arm the double-esc
// rewind chord (v0.32.0). Returns { action, data } where action ∈ insert|submit|
// newline|backspace|delete|left|right|home|end|kill-line|kill-word-before|history-prev|
// history-next|complete|mode-cycle|palette-prev|palette-next|escape|rewind|
// transcript|detach|sigint|eof|null
export function applyKey(key, ctx = {}) {
  const name = key.name ?? '';
  if (key.ctrl && name === 'c') return { action: 'sigint' };
  if (key.ctrl && name === 'd') return { action: 'eof' };
  if (name === 'escape' || key.sequence === '\x1b') {
    // palette and question escapes are functional, not chords — never arm rewind
    if (ctx.paletteOpen || ctx.questionMode) return { action: 'escape' };
    // REAL-TERMINAL WIRE FORMAT (caught live by the v0.32.0 drill): a fast
    // double-press never arrives as two escape keypresses — readline's decoder
    // coalesces the two ESC bytes into ONE keypress {meta:true, sequence:
    // '\x1b\x1b'}. That coalesced key IS the chord.
    if (key.meta && key.sequence === '\x1b\x1b') return { action: 'rewind' };
    if (isDoubleEscape(ctx.lastEscapeAt, ctx.now)) return { action: 'rewind' }; // v0.32.0: slow double-press
    return { action: 'escape' };
  }
  if (name === 'return' || name === 'enter') {
    // WIRE TRUTH (v0.33.0): in raw mode the real Enter arrives as \r
    // (readline: name 'return'). A literal LF byte arrives as name 'enter' /
    // sequence '\n' — that byte IS ctrl+j, and it is what /terminal-setup
    // teaches shift+enter to send, so it inserts a newline instead of
    // submitting. alt+enter arrives as the coalesced ESC chord ESC+\r
    // (meta on) — newline too. Unknown shapes default to submit, exactly
    // today's behavior, so exotic terminals can never lose their Enter.
    if (key.meta) return { action: 'newline' };
    if (name === 'enter' || key.sequence === '\n') return { action: 'newline' };
    return { action: 'submit' };
  }
  if (name === 'backspace' || (key.ctrl && name === 'h')) return { action: 'backspace' };
  if (name === 'delete') return { action: 'delete' };
  if (name === 'left') return { action: 'left' }; // v0.34.0: plain left only — ctrl+b moved to the dual-duty branch below
  if (name === 'right' || (key.ctrl && name === 'f')) return { action: 'right' };
  if (name === 'home' || (key.ctrl && name === 'a')) return { action: 'home' };
  if (name === 'end' || (key.ctrl && name === 'e')) return { action: 'end' };
  if (key.ctrl && name === 'u') return { action: 'kill-to-line-start' }; // v0.33.0: line-scoped (was: everything after cursor)
  if (key.ctrl && name === 'k') return { action: 'kill-to-line-end' };  // v0.33.0: line-scoped
  if (key.ctrl && name === 'w') return { action: 'kill-word-before' };
  if (key.ctrl && name === 'o') return { action: 'verbose-toggle' }; // v0.30.0: expand/collapse the stream transcript
  if (key.ctrl && name === 'r') return { action: 'transcript' }; // v0.31.0: open the ctrl+r transcript viewer
  if (key.ctrl && name === 'b') {
    // v0.34.0: ctrl+b is DUAL-DUTY at the busy boundary (esc already works
    // this way: idle = clear draft, busy = interrupt). While a turn runs it
    // detaches the turn to the background (prompt returns, output mutes);
    // while idle it stays the emacs cursor-left binding.
    if (ctx.busy) return { action: 'detach' };
    return { action: 'left' };
  }
  if (name === 'up') return ctx.paletteOpen ? { action: 'palette-prev' } : { action: 'history-prev' };
  if (name === 'down') return ctx.paletteOpen ? { action: 'palette-next' } : { action: 'history-next' };
  if (name === 'tab') return key.shift ? { action: 'mode-cycle' } : { action: 'complete' };
  const seq = key.sequence ?? '';
  if (!key.ctrl && !key.meta && seq >= ' ' && !seq.startsWith('\x1b')) {
    return { action: 'insert', data: seq };
  }
  return { action: null };
}

/** Which palette items does the current text match? Pure. */
export function filterCommands(commands, text) {
  const t = String(text ?? '');
  if (!t.startsWith('/') || /\s/.test(t.slice(1))) return [];
  return (commands || []).filter((cmd) => (t === '/' ? true : cmd.name.startsWith(t)));
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function cursorBlock(ch) { return c.inverse(ch || ' '); }

// Apply an inverse-video block cursor at visual column `ci` of a wrapped line.
function withCursor(line, ci) {
  const chars = Array.from(line);
  let w = 0; let idx = chars.length;
  for (let j = 0; j < chars.length; j++) {
    if (w + charWidth(chars[j]) > ci) { idx = j; break; }
    w += charWidth(chars[j]);
  }
  const head = chars.slice(0, idx).join('');
  const at = chars[idx] ?? ' ';
  const tail = chars.slice(idx + (chars[idx] !== undefined ? 1 : 0)).join('');
  return head + c.inverse(at) + tail;
}

// ── The frame painter (pure, unit-tested) ────────────────────────────────────
//
// state: {
//   text, cursor, placeholder, hint,
//   question: string|null          — question-mode prompt text (as placeholder)
//   busy: null | { label, secs, glyph }
//   statusRight: string
//   palette: null | { items: [{name, desc}], sel }
//   viewer: null | { open, rows, scroll }   — ctrl+r transcript viewer (v0.31.0)
//   menu: null | { open, entries, sel }     — double-esc rewind menu (v0.32.0)
// }
// Returns string[] — every line guaranteed ≤ W so nothing ever wraps.

export function buildFrame(state, cols) {
  const W = Math.min(Math.max(cols ?? 80, 34), 100); // total width incl. 2-col indent

  // ── transcript viewer (ctrl+r, v0.31.0) ── replaces the whole frame: the
  // session's scrollback in a scrollable panel; the spin timer repaints it so
  // a running turn live-tails while you browse.
  if (state.viewer?.open) {
    return buildTranscriptPanel({
      lines: state.transcript || [],
      cols: W,
      rows: state.viewer.rows,
      scroll: state.viewer.scroll,
      busy: state.busy,
      tick: state.tick || 0,
    });
  }

  // ── rewind menu (double-esc, v0.32.0) ── replaces the whole frame: the
  // checkpoint list over the box; the spin timer repaints it like the viewer.
  if (state.menu?.open) {
    return buildRewindMenu({
      entries: state.menu.entries || [],
      sel: state.menu.sel,
      cols: W,
    });
  }

  const CW = W - 6;  // inner width between `│ ` and ` │`
  const TW = W - 8;  // text width after the `> ` prompt
  const lines = [];
  const border = (l, r) => `  ${l}${'─'.repeat(Math.max(1, W - 4))}${r}`;

  // ── palette popup ──
  if (state.palette?.items?.length) {
    const items = state.palette.items;
    const maxShow = 7;
    let start = 0;
    if (items.length > maxShow) start = Math.max(0, Math.min(state.palette.sel - 3, items.length - maxShow));
    const win = items.slice(start, start + maxShow);
    const maxName = Math.min(16, Math.max(...items.map((x) => strWidth(x.name))));
    lines.push(border('╭', '╮'));
    for (let i = 0; i < win.length; i++) {
      const item = win[i];
      const abs = start + i;
      const desc = truncateAnsi(item.desc || '', Math.max(8, CW - maxName - 5));
      let content = ` ${c.bold(item.name.padEnd(maxName + 1))} ${c.dim(desc)}`;
      content = truncateAnsi(content, CW);
      const pad = Math.max(0, CW - strWidth(content));
      const row = `  │ ${content}${' '.repeat(pad)} │`;
      lines.push(abs === state.palette.sel ? c.inverse(row) : row);
    }
    lines.push(border('╰', '╯'));
  }

  // ── input box ──
  lines.push(border('╭', '╮'));

  let shown;
  if (state.text === '') {
    const ph = truncateAnsi(c.dim(c.gray(String(state.placeholder ?? ''))), Math.max(1, TW - 2));
    shown = [ph + cursorBlock('')];
  } else {
    // v0.33.0: newline-aware wrap + cursor mapping. wrapContent splits on \n,
    // but a \n costs one INDEX while occupying ZERO columns — the old loop
    // subtracted visible widths only, so every newline drifted the caret one
    // row off. Walk logical lines instead: locate the caret's line, then its
    // wrapped row inside that line.
    const starts = lineStarts(state.text);
    const { line: caretLine, col: caretCol } = posToLineCol(state.text, state.cursor);
    const perLine = []; // wrapped rows per logical line
    for (let i = 0; i < starts.length; i++) {
      const segEnd = i + 1 < starts.length ? starts[i + 1] - 1 : state.text.length;
      perLine.push(wrapContent(state.text.slice(starts[i], segEnd), TW));
    }
    const wrapped = perLine.flat();
    // locate the caret's wrapped row + column. UNITS MATTER: posToLineCol
    // returns a CHAR column, but wrapped rows and withCursor work in VISUAL
    // columns (CJK = 2 cols per char) — convert before comparing, or the
    // caret lands "early" on any line containing wide characters.
    let before = 0; // wrapped rows before the caret's line
    for (let i = 0; i < caretLine && i < perLine.length; i++) before += perLine[i].length;
    const segRows = perLine[Math.min(caretLine, perLine.length - 1)] ?? [''];
    const segStart = starts[Math.min(caretLine, starts.length - 1)];
    const segEnd = caretLine + 1 < starts.length ? starts[caretLine + 1] - 1 : state.text.length;
    const caretVis = strWidth(state.text.slice(segStart, segStart + caretCol)); // visual column of the caret
    let li = before;
    let ci = caretVis;
    let acc = 0; // visible columns consumed by earlier rows of the caret's line
    for (let rr = 0; rr < segRows.length; rr++) {
      const wLen = strWidth(segRows[rr]);
      if (caretVis <= wLen || rr === segRows.length - 1) {
        li = before + rr;
        ci = Math.max(0, Math.min(caretVis - acc, wLen));
        break;
      }
      acc += wLen;
    }
    const total = wrapped.length;
    let windowStart = 0;
    if (total > 8) windowStart = Math.max(0, Math.min(li - Math.floor(8 / 2), total - 8));
    const win = wrapped.slice(windowStart, windowStart + 8);
    const liRel = li - windowStart;
    shown = win.map((l, i) => (i !== liRel ? l : withCursor(l, ci)));
  }

  shown.forEach((cl, i) => {
    const prefix = i === 0 ? `${c.gray('>')} ` : '  ';
    const pad = Math.max(0, TW - strWidth(cl));
    lines.push(`  │ ${prefix}${cl}${' '.repeat(pad)} │`);
  });

  lines.push(border('╰', '╯'));

  // ── footer: hint / busy spinner (+ live streaming thought line) ──
  let left; const right = state.statusRight ? c.dim(state.statusRight) : '';
  if (state.busy) {
    left = `${c.cyan(state.busy.glyph)} ${c.bold(state.busy.label)}${c.dim(` · esc to interrupt · ${state.busy.secs}s`)}`;
  } else {
    left = c.dim(String(state.hint ?? ''));
  }
  const room = W - 2;
  if (left && right && strWidth(left) + strWidth(right) + 4 <= room) {
    const gap = ' '.repeat(room - strWidth(left) - strWidth(right));
    lines.push(`  ${left}${gap}${right}`);
  } else if (left) {
    lines.push(`  ${truncateAnsi(left, room)}`);
  } else if (right) {
    lines.push(`  ${truncateAnsi(right, room)}`);
  }
  // Streaming thought (v0.28.0 → Aurora v0.29.0): the brain's reply as it
  // lands, now a 3-line aurora rail — live narration words, the tool being
  // formed, and telemetry (↓ tokens · tool calls · elapsed). The gradient
  // edge sweeps with the spin timer. Gone the moment the step renders.
  if (state.busy && state.thought) {
    const strip = buildAuroraStrip({
      snap: state.thought,
      ms: (state.busy.secs || 0) * 1000,
      bytes: state.thought?.bytes || 0,
      cols: W,
      tick: state.tick || 0,
      toolCalls: state.toolCalls || 0,
      verbose: !!state.verbose, // ctrl+o: narration expands to the 3-row mini transcript
    });
    for (const l of strip) lines.push(`  ${l}`);
  }

  // never let a line wrap — the ghost-box killer
  return lines.map((l) => (strWidth(l) > W ? truncateAnsi(l, W) : l));
}

// ── The box ──────────────────────────────────────────────────────────────────

export function createInputBox({
  title = 'Buddy',
  placeholder = '',
  hint = '',
  statusRight = null,   // () => string
  commands = [],        // [{ name: '/help', desc: '...' }] for the palette
  historySize = 400,
  record = null,        // flight recorder: append the pristine render byte-stream to this file
} = {}) {
  let text = '';
  let cursor = 0;
  let mode = 'input';            // 'input' | 'question' | 'closed'
  let questionText = '';
  let questionCb = null;
  let busyLabel = null;
  let busyThought = null; // Aurora: the RAW extractor snapshot (+ bytes), not a preformatted string
  let toolCallsCount = 0;
  let verbose = false; // ctrl+o (v0.30.0): expanded transcript — strip narration + full observations
  let viewerOpen = false; // ctrl+r (v0.31.0): transcript viewer over the box
  let viewerScroll = 0; // rows scrolled up from the live tail (0 = tail)
  const transcript = []; // session scrollback, SGR kept, capped at VIEWER.MAX_BUFFER
  let menuOpen = false; // double-esc (v0.32.0): rewind menu over the box
  let menuSel = 0;
  let menuEntries = [];
  let lastEscapeAt = 0; // arms the double-esc chord; any other key disarms
  let vimOn = false; // /vim (v0.33.0): modal editing on the draft
  let vim = createVimState();
  let busyStart = 0;
  let spinIdx = 0;
  let spinTimer = null;
  const history = [];
  let histIdx = -1;
  let draft = '';
  let paletteSel = 0;
  let paletteClosed = false;     // esc-dismissed until the text changes
  const handlers = {};
  let renderer = null;
  void title;
  void commands;
  void historySize;

  function paletteItems() {
    if (mode !== 'input' || paletteClosed || busyLabel) return [];
    return filterCommands(commands, text);
  }

  function frameState() {
    const items = paletteItems();
    if (paletteSel >= items.length) paletteSel = Math.max(0, items.length - 1);
    let sr = typeof statusRight === 'function' ? (statusRight() || '') : (statusRight || '');
    if (vimOn) sr = sr ? `${sr} · vim` : 'vim'; // mode is visible or it isn't real
    return {
      text,
      cursor,
      placeholder: mode === 'question' ? questionText : placeholder,
      hint,
      busy: busyLabel
        ? { label: busyLabel, secs: Math.max(0, Math.floor((Date.now() - busyStart) / 1000)), glyph: FRAMES[spinIdx % FRAMES.length] }
        : null,
      thought: busyThought,
      tick: spinIdx,
      toolCalls: toolCallsCount,
      verbose,
      viewer: viewerOpen
        ? { open: true, rows: viewerBodyRows(process.stdout?.rows, process.stdout?.columns), scroll: viewerScroll }
        : null,
      transcript: viewerOpen ? transcript.slice() : null,
      menu: menuOpen ? { open: true, entries: menuEntries, sel: menuSel } : null,
      statusRight: sr,
      palette: items.length ? { items, sel: paletteSel } : null,
    };
  }

  function ensureRenderer(outOverride) {
    if (!renderer) {
      renderer = createRenderer({
        out: outOverride || process.stdout,
        frame: (cols0) => buildFrame(frameState(), Math.min(Math.max(cols0 ?? 80, 34), 100)),
        onPrint: pushTranscript, // v0.31.0: capture every scrollback byte for ctrl+r
      });
    }
    return renderer;
  }

  function redraw() {
    if (mode === 'closed') return;
    ensureRenderer().render();
  }

  function resetPaletteState() {
    paletteSel = 0;
    paletteClosed = false;
  }

  // v0.31.0 capture: the renderer hands us every flushed scrollback chunk —
  // user echoes, tool cards, say blocks, ribbons — exactly as printed. SGR
  // stays (the viewer shows the session in its own colors); cursor moves,
  // OSC and \r artifacts are stripped. Capped: old lines fall off the top.
  function pushTranscript(chunk) {
    const lines = sanitizeChunk(chunk);
    if (!lines.length) return;
    transcript.push(...lines);
    if (transcript.length > VIEWER.MAX_BUFFER) transcript.splice(0, transcript.length - VIEWER.MAX_BUFFER);
    if (viewerOpen) redraw(); // live tail while browsing
  }

  function insertText(data) {
    text = text.slice(0, cursor) + data + text.slice(cursor);
    cursor += data.length;
    resetPaletteState();
  }

  function acceptPalette(items) {
    const list = items?.length ? items : paletteItems();
    if (!list.length) return;
    const item = list[Math.min(paletteSel, list.length - 1)];
    text = item.name + ' ';
    cursor = text.length;
    resetPaletteState();
  }

  function submitLine() {
    const submitted = text;
    const wasQuestion = mode === 'question';
    text = ''; cursor = 0;
    resetPaletteState();
    const r = ensureRenderer();
    if (wasQuestion) {
      mode = 'input';
      questionText = '';
      const cb = questionCb;
      questionCb = null;
      r.render();
      cb?.(submitted);
      return;
    }
    if (submitted.trim()) {
      if (history[0] !== submitted) history.unshift(submitted);
      if (history.length > historySize) history.pop();
      // echo into scrollback — violet: the human spoke. The trailing \n is
      // NOT cosmetic: print() holds unterminated text in its pending buffer,
      // so the next print (a tool card has no leading \n) would glue onto
      // the echo and both would render as one wrapped line (caught live by
      // the v0.31.0 transcript capture — the buffer showed echo+todo fused).
      // Multi-line drafts (v0.33.0): continuation lines indent under the ❯
      // so the echo reads as one spoken block.
      const echo = submitted.split('\n').join('\n    ');
      r.print(`  ${SEM.narrate('❯')} ${echo}\n`);
      handlers.line?.(submitted);
    } else {
      r.render();
    }
    histIdx = -1; draft = '';
  }

  // ── vim routing (v0.33.0) ── /vim: modal editing on the draft. NORMAL mode
  // consumes keys through the pure reducer; INSERT mode is the classic editor
  // except esc (mode exit). The palette bypasses vim so '/' navigation stays
  // live, and question mode bypasses vim entirely (answers keep the classic
  // semantics — ctrl+c owns deny there, and a pending question must never
  // depend on a mode the user forgot is on).
  function routeVim(key, items) {
    if (!vimOn || mode !== 'input') return null;
    if (vim.mode === 'insert') {
      const coalesced = key.meta && key.sequence === '\x1b\x1b'; // busy interrupt pair — never modal
      if (!coalesced && (key.name === 'escape' || key.sequence === '\x1b')) {
        vim.mode = 'normal';
        // vim semantics: leaving insert parks the caret ON the last typed
        // char (one left) — so a following x/dd act on what was just typed
        // instead of the void past the end.
        if (cursor > 0) cursor -= 1;
        lastEscapeAt = 0;
        redraw();
        return { handled: true };
      }
      return null; // insert mode IS the classic editor
    }
    const r = applyVimKey(key, vim, text, cursor);
    vim = r.st;
    if (r.op === 'inert') return { handled: true }; // consumed, nothing to repaint
    if (r.op === 'edit') {
      text = r.text;
      cursor = r.cursor;
      lastEscapeAt = 0;
      resetPaletteState();
      redraw();
      return { handled: true };
    }
    return { action: r.action, data: r.data }; // passthrough: the shared switch owns semantics
  }

  function onKeypress(key) {
    if (mode === 'closed') return;
    key = key || {};
    // BUDDY_KEYLOG=<file> — dev diagnostics: every keypress the box sees
    if (process.env.BUDDY_KEYLOG) {
      try {
        fs.appendFileSync(process.env.BUDDY_KEYLOG, `${Date.now() % 1000000} ${JSON.stringify({ name: key.name ?? null, seq: key.sequence ?? null, ctrl: !!key.ctrl, meta: !!key.meta })}\n`);
      } catch { /* diagnostics only */ }
    }
    // ── transcript viewer owns EVERY key while open (v0.31.0) ── the editor is
    // inert: no key can mutate the draft, interrupt the turn or quit; ctrl+c
    // and esc just close the pager, like Claude Code's.
    if (viewerOpen) {
      const { action } = applyViewerKey(key);
      if (action === 'close') { viewerOpen = false; viewerScroll = 0; }
      else if (action === 'up') viewerScroll += 1;
      else if (action === 'down') viewerScroll = Math.max(0, viewerScroll - 1);
      else if (action === 'pageup') viewerScroll += viewerBodyRows(process.stdout?.rows, process.stdout?.columns);
      else if (action === 'pagedown') viewerScroll = Math.max(0, viewerScroll - viewerBodyRows(process.stdout?.rows, process.stdout?.columns));
      else if (action === 'top') viewerScroll = Number.MAX_SAFE_INTEGER; // panel clamps to the top
      else if (action === 'bottom') viewerScroll = 0; // live tail again
      else return; // inert key: no repaint needed
      redraw();
      return;
    }
    // ── rewind menu owns EVERY key while open (v0.32.0) ── the editor is
    // inert; enter confirms the restore (the menu closes first so the result
    // note prints through the renderer into plain scrollback), esc closes.
    if (menuOpen) {
      const { action } = applyRewindMenuKey(key);
      if (action === 'close') { menuOpen = false; menuSel = 0; menuEntries = []; }
      else if (action === 'up') menuSel = Math.max(0, menuSel - 1);
      else if (action === 'down') menuSel = Math.min(menuEntries.length - 1, menuSel + 1);
      else if (action === 'confirm') {
        menuOpen = false;
        const idx = menuSel;
        menuSel = 0; menuEntries = [];
        handlers.rewind?.(idx);
        return; // the restore note prints through the renderer
      } else return; // inert key: no repaint needed
      redraw();
      return;
    }
    // bracketed paste → unwrap and insert as one line
    const pm = /^\x1b\[200~([\s\S]*)\x1b\[201~\s*$/.exec(String(key.sequence ?? ''));
    if (pm) {
      const payload = pm[1].replace(/\r\n|\r|\n/g, ' ').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      if (payload) insertText(payload);
      redraw();
      return;
    }
    // ── ctrl+b detach (v0.34.0) ── checked BEFORE vim routing: while a turn
    // runs, ctrl+b detaches regardless of vim mode (a modal editor has no
    // business paging a draft mid-turn, and the detach must be reliable);
    // while idle, vim's ctrl+b / emacs cursor-left behave as before.
    if (key.ctrl && key.name === 'b' && busyLabel && mode === 'input' && !viewerOpen && !menuOpen) {
      handlers.detach?.();
      return;
    }
    const items = paletteItems();
    const now = Date.now();
    const vr = routeVim(key, items);
    if (vr?.handled) return; // vim applied the key (and repainted) itself
    let action; let data;
    if (vr) {
      ({ action, data } = vr);
    } else {
      ({ action, data } = applyKey(key, {
        paletteOpen: items.length > 0,
        questionMode: mode === 'question',
        lastEscapeAt,
        now,
        busy: Boolean(busyLabel) && mode === 'input',
      }));
    }
    if (action !== 'escape' && action !== 'rewind') lastEscapeAt = 0; // chord needs CONSECUTIVE escapes
    switch (action) {
      case 'insert': insertText(data); break;
      case 'newline': insertText('\n'); break; // v0.33.0: ctrl+j / alt+enter / taught shift+enter
      case 'backspace': if (cursor > 0) { text = text.slice(0, cursor - 1) + text.slice(cursor); cursor--; resetPaletteState(); } break;
      case 'delete': text = text.slice(0, cursor) + text.slice(cursor + 1); resetPaletteState(); break;
      case 'left': if (cursor > 0) cursor--; break;
      case 'right': if (cursor < text.length) cursor++; break;
      case 'home': { // v0.33.0: line-scoped — the draft can hold many lines now
        const starts0 = lineStarts(text);
        const { line: l0 } = posToLineCol(text, cursor);
        cursor = starts0[l0];
        break;
      }
      case 'end': { // line-scoped end
        const starts0 = lineStarts(text);
        const { line: l0 } = posToLineCol(text, cursor);
        cursor = l0 + 1 < starts0.length ? starts0[l0 + 1] - 1 : text.length;
        break;
      }
      case 'kill-to-line-start': { // ctrl+u: clear the caret's line LEFT only —
        // the old draft-global kill was a data-loss footgun on multi-line tasks
        const ks = lineStarts(text);
        const { line: kl } = posToLineCol(text, cursor);
        text = text.slice(0, ks[kl]) + text.slice(cursor);
        cursor = ks[kl];
        resetPaletteState();
        break;
      }
      case 'kill-to-line-end': { // ctrl+k: clear the caret's line RIGHT only
        const ks = lineStarts(text);
        const { line: kl } = posToLineCol(text, cursor);
        const kend = kl + 1 < ks.length ? ks[kl + 1] - 1 : text.length;
        text = text.slice(0, cursor) + text.slice(kend);
        resetPaletteState();
        break;
      }
      case 'kill-line': { // legacy alias (pre-0.33 callers): kill to line end
        const ks = lineStarts(text);
        const { line: kl } = posToLineCol(text, cursor);
        const kend = kl + 1 < ks.length ? ks[kl + 1] - 1 : text.length;
        text = text.slice(0, cursor) + text.slice(kend);
        resetPaletteState();
        break;
      }
      case 'kill-word-before': {
        const before = text.slice(0, cursor).replace(/\S*\s*$/, '');
        text = before + text.slice(cursor);
        cursor = before.length;
        resetPaletteState();
        break;
      }
      case 'history-prev': {
        // v0.33.0: a multi-line draft navigates ITS OWN lines first — ↑ moves
        // the caret line by line (even with empty history); history recalls
        // only once the caret is already on the first line (Claude Code's
        // up-at-top rule).
        if (mode !== 'input') break;
        const up = text.includes('\n') ? caretUp(text, cursor) : null;
        if (up != null) { cursor = up; break; }
        if (history.length) {
          if (histIdx === -1) draft = text;
          histIdx = Math.min(histIdx + 1, history.length - 1);
          text = history[histIdx]; cursor = text.length;
          resetPaletteState();
        }
        break;
      }
      case 'history-next': {
        if (mode !== 'input') break;
        const down = text.includes('\n') ? caretDown(text, cursor) : null;
        if (down != null) { cursor = down; break; }
        if (histIdx !== -1) {
          histIdx--;
          text = histIdx === -1 ? draft : history[histIdx];
          cursor = text.length;
          resetPaletteState();
        }
        break;
      }
      case 'palette-prev': paletteSel = Math.max(0, paletteSel - 1); break;
      case 'palette-next': paletteSel = Math.min(items.length - 1, paletteSel + 1); break;
      case 'complete': acceptPalette(items); break;
      case 'verbose-toggle': // ctrl+o: expand/collapse — repl.js widens observations too
        verbose = !verbose;
        handlers.verbose?.(verbose);
        break;
      case 'transcript': // ctrl+r (v0.31.0): open the transcript viewer over the box
        viewerOpen = true;
        viewerScroll = 0; // live tail first — the newest work is the news
        break;
      case 'detach': // ctrl+b (v0.34.0): background the running turn — the repl
        handlers.detach?.(); // owns the note + footer release; no repaint here
        return;
      case 'mode-cycle': handlers.modecycle?.(); break; // shift+tab: normal → auto-accept → plan
      case 'submit': submitLine(); return; // submitLine handles its own repaint
      case 'escape':
        if (items.length) { paletteClosed = true; lastEscapeAt = 0; break; } // palette close is not a chord
        lastEscapeAt = now; // arm (or re-arm) the double-esc window
        if (busyLabel) { handlers.escape?.(); return; }
        if (mode === 'question') break; // Ctrl+C owns deny; esc keeps the question
        if (text) { text = ''; cursor = 0; }
        break;
      case 'rewind': { // v0.32.0: double-esc — open the rewind menu over the box
        if (busyLabel) { handlers.escape?.(); break; } // mid-turn both escapes interrupt; the menu is an idle affordance
        const entries = handlers.rewindOpen?.() ?? [];
        if (entries.length) { menuOpen = true; menuSel = 0; menuEntries = entries; }
        break;
      }
      case 'sigint': handlers.SIGINT?.(); return;
      case 'eof':
        if (!text) { close(); return; }
        break;
      default: return; // unhandled key: no repaint needed
    }
    redraw();
  }

  function close() {
    if (mode === 'closed') return;
    mode = 'closed';
    if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
    if (renderer) renderer.close();
    // unpatch stdout FIRST so late output (goodbye, crash logs) always lands
    if (rl._patchedWrite && process.stdout.write === rl._patchedWrite) {
      process.stdout.write = rl._origWrite;
    }
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* not a tty */ }
    process.stdin.removeListener('keypress', onKeypress);
    process.stdout.removeListener('resize', onResize);
    handlers.close?.();
  }

  function onResize() { if (mode !== 'closed') ensureRenderer().render(); }

  const rl = {
    prompt() { redraw(); },
    setPrompt() { /* kept for readline API compatibility; the box owns its labels */ },
    setBusy(label) {
      busyLabel = label || null;
      if (busyLabel && menuOpen) { menuOpen = false; menuSel = 0; menuEntries = []; } // defensive: a turn never starts under the menu
      if (busyLabel) {
        busyStart = Date.now();
        if (!spinTimer) spinTimer = setInterval(() => { spinIdx++; redraw(); }, 120);
      } else if (spinTimer) {
        clearInterval(spinTimer); spinTimer = null;
      }
      redraw();
    },
    // Live thought (v0.28.0) — Aurora v0.29.0: `t` is now the RAW extractor
    // snapshot { tool, message, messageClosed, raw, bytes? }; buildFrame
    // expands it into the 3-line strip. Only visible while busy; the 120ms
    // spin timer repaints it, so a burst of deltas costs one frame at most.
    setThought(t) {
      busyThought = t || null;
      if (busyLabel) redraw();
    },
    // Tool-call counter for the strip telemetry (kept in sync by repl.js).
    setToolCalls(n) {
      toolCallsCount = Math.max(0, Number(n) || 0);
      if (busyLabel) redraw();
    },
    question(q, cb) { mode = 'question'; questionText = q; questionCb = cb; text = ''; cursor = 0; menuOpen = false; resetPaletteState(); redraw(); },
    cancelQuestion() { if (mode === 'question') { mode = 'input'; questionText = ''; questionCb = null; text = ''; cursor = 0; redraw(); } },
    close,
    on(ev, fn) { handlers[ev] = fn; return rl; },
    // test / harness seam: drive the box's key reducer directly
    _handleKeypress(key) { onKeypress(key || {}); },
    // /vim (v0.33.0): toggle modal editing; a fresh state every time so a
    // half-finished pending op or count can never leak across sessions
    // (question mode bypasses the reducer by design — routeVim checks mode)
    setVim(on) {
      vimOn = !!on;
      vim = createVimState();
      redraw();
    },
    // test seam (v0.31.0): feed the transcript capture directly (what install()'s
    // onPrint wiring receives from renderer.print in production)
    _capture: pushTranscript,
    // test / introspection hooks
    _state: () => ({ text, cursor, mode, history: [...history], busy: busyLabel, thought: busyThought, toolCalls: toolCallsCount, verbose, viewer: viewerOpen ? { scroll: viewerScroll } : null, menu: menuOpen ? { sel: menuSel, count: menuEntries.length } : null, vim: vimOn ? { mode: vim.mode, pending: vim.pending, count: vim.count } : null, transcriptLines: transcript.length, palette: paletteItems().map((i) => i.name) }),
  };

  rl.install = function install() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    // Flight recorder (v0.29.0): EVERY byte the TUI emits, appended pristine
    // to `record`. The live terminal can mangle, filter or strip escapes
    // (sandboxed PTYs do); the recording is the renderer's honest truth —
    // replayable through any terminal emulator, diffable in CI, attachable
    // to bug reports. Synchronous appends: process.exit(0) must never
    // truncate the tail (an async stream loses its last chunks on exit,
    // which desynchronizes erase/frame pairs on replay).
    let recFd = null;
    if (record) {
      try { recFd = fs.openSync(record, 'a'); } catch { /* best effort */ }
    }
    const recWrite = (s) => {
      if (recFd == null) return;
      try { fs.writeSync(recFd, s); } catch { /* diagnostics only */ }
    };
    // capture the ORIGINAL write BEFORE patching — the renderer's own writes
    // go through it and can never recurse through the print-above patch
    const origWrite = process.stdout.write.bind(process.stdout);
    const rout = {
      get columns() { return process.stdout.columns || 80; },
      write: (s) => { recWrite(s); return origWrite(s); },
      on: (ev, fn) => process.stdout.on(ev, fn),
      removeListener: (ev, fn) => process.stdout.removeListener(ev, fn),
    };
    renderer = null;
    ensureRenderer(rout);
    // print-above: ALL stdout writes route through the renderer, which erases
    // the frame, prints the content, and re-anchors the frame below it
    const patched = function patchedWrite(chunk, ...rest) {
      const s = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      renderer.print(s);
      void rest;
      return true;
    };
    process.stdout.write = patched;
    rl._patchedWrite = patched;
    rl._origWrite = origWrite;
    process.stdin.on('keypress', (_ch, key) => onKeypress(key || { sequence: _ch }));
    process.stdout.on('resize', onResize);
    renderer.render();
    rout.write('\x1b[?25l'); // hide the hardware cursor — the box draws its own block cursor
  };

  return rl;
}
