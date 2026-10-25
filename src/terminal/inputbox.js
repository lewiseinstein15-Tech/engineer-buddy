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

import readline from 'node:readline';
import { createRenderer } from './renderer.js';
import { c } from './ui.js';
import { charWidth, strWidth, wrapContent, truncateAnsi } from './text.js';

export { charWidth, strWidth, wrapContent };

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Key reducer: maps a keypress to an editing action (pure, unit-tested).
// key: { name?, ctrl?, meta?, sequence? } — the node keypress event shape.
// ctx: { paletteOpen? } — switches ↑/↓ from history to palette navigation.
// Returns { action, data } where action ∈ insert|submit|backspace|delete|left|right|
// home|end|kill-line|kill-word-before|history-prev|history-next|complete|
// mode-cycle|palette-prev|palette-next|escape|sigint|eof|null
export function applyKey(key, ctx = {}) {
  const name = key.name ?? '';
  if (key.ctrl && name === 'c') return { action: 'sigint' };
  if (key.ctrl && name === 'd') return { action: 'eof' };
  if (name === 'escape' || key.sequence === '\x1b') return { action: 'escape' };
  if (name === 'return' || name === 'enter') return { action: 'submit' };
  if (name === 'backspace' || (key.ctrl && name === 'h')) return { action: 'backspace' };
  if (name === 'delete') return { action: 'delete' };
  if (name === 'left' || (key.ctrl && name === 'b')) return { action: 'left' };
  if (name === 'right' || (key.ctrl && name === 'f')) return { action: 'right' };
  if (name === 'home' || (key.ctrl && name === 'a')) return { action: 'home' };
  if (name === 'end' || (key.ctrl && name === 'e')) return { action: 'end' };
  if (key.ctrl && name === 'u') return { action: 'kill-line' };
  if (key.ctrl && name === 'k') return { action: 'kill-line' };
  if (key.ctrl && name === 'w') return { action: 'kill-word-before' };
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
// }
// Returns string[] — every line guaranteed ≤ W so nothing ever wraps.

export function buildFrame(state, cols) {
  const W = Math.min(Math.max(cols ?? 80, 34), 100); // total width incl. 2-col indent
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
    const wrapped = wrapContent(state.text, TW);
    // map absolute cursor to wrapped position
    let remaining = state.cursor;
    let li = 0; let ci = 0;
    for (let i = 0; i < wrapped.length; i++) {
      const wLen = strWidth(wrapped[i]);
      if (remaining <= wLen || i === wrapped.length - 1) { li = i; ci = remaining; break; }
      remaining -= wLen;
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

  // ── footer: hint / busy spinner ──
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
} = {}) {
  let text = '';
  let cursor = 0;
  let mode = 'input';            // 'input' | 'question' | 'closed'
  let questionText = '';
  let questionCb = null;
  let busyLabel = null;
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
    return {
      text,
      cursor,
      placeholder: mode === 'question' ? questionText : placeholder,
      hint,
      busy: busyLabel
        ? { label: busyLabel, secs: Math.max(0, Math.floor((Date.now() - busyStart) / 1000)), glyph: FRAMES[spinIdx % FRAMES.length] }
        : null,
      statusRight: typeof statusRight === 'function' ? (statusRight() || '') : (statusRight || ''),
      palette: items.length ? { items, sel: paletteSel } : null,
    };
  }

  function ensureRenderer(outOverride) {
    if (!renderer) {
      renderer = createRenderer({
        out: outOverride || process.stdout,
        frame: (cols0) => buildFrame(frameState(), Math.min(Math.max(cols0 ?? 80, 34), 100)),
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
      r.print(`  ${c.gray('>')} ${submitted}`); // echo into scrollback, Claude Code style
      handlers.line?.(submitted);
    } else {
      r.render();
    }
    histIdx = -1; draft = '';
  }

  function onKeypress(key) {
    if (mode === 'closed') return;
    key = key || {};
    // bracketed paste → unwrap and insert as one line
    const pm = /^\x1b\[200~([\s\S]*)\x1b\[201~\s*$/.exec(String(key.sequence ?? ''));
    if (pm) {
      const payload = pm[1].replace(/\r\n|\r|\n/g, ' ').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      if (payload) insertText(payload);
      redraw();
      return;
    }
    const items = paletteItems();
    const { action, data } = applyKey(key, { paletteOpen: items.length > 0 });
    switch (action) {
      case 'insert': insertText(data); break;
      case 'backspace': if (cursor > 0) { text = text.slice(0, cursor - 1) + text.slice(cursor); cursor--; resetPaletteState(); } break;
      case 'delete': text = text.slice(0, cursor) + text.slice(cursor + 1); resetPaletteState(); break;
      case 'left': if (cursor > 0) cursor--; break;
      case 'right': if (cursor < text.length) cursor++; break;
      case 'home': cursor = 0; break;
      case 'end': cursor = text.length; break;
      case 'kill-line': text = text.slice(0, cursor); resetPaletteState(); break;
      case 'kill-word-before': {
        const before = text.slice(0, cursor).replace(/\S*\s*$/, '');
        text = before + text.slice(cursor);
        cursor = before.length;
        resetPaletteState();
        break;
      }
      case 'history-prev':
        if (mode === 'input' && history.length) {
          if (histIdx === -1) draft = text;
          histIdx = Math.min(histIdx + 1, history.length - 1);
          text = history[histIdx]; cursor = text.length;
          resetPaletteState();
        }
        break;
      case 'history-next':
        if (mode === 'input' && histIdx !== -1) {
          histIdx--;
          text = histIdx === -1 ? draft : history[histIdx];
          cursor = text.length;
          resetPaletteState();
        }
        break;
      case 'palette-prev': paletteSel = Math.max(0, paletteSel - 1); break;
      case 'palette-next': paletteSel = Math.min(items.length - 1, paletteSel + 1); break;
      case 'complete': acceptPalette(items); break;
      case 'mode-cycle': handlers.modecycle?.(); break; // shift+tab: normal → auto-accept → plan
      case 'submit': submitLine(); return; // submitLine handles its own repaint
      case 'escape':
        if (items.length) { paletteClosed = true; break; }
        if (busyLabel) { handlers.escape?.(); return; }
        if (mode === 'question') break; // Ctrl+C owns deny; esc keeps the question
        if (text) { text = ''; cursor = 0; }
        break;
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
      if (busyLabel) {
        busyStart = Date.now();
        if (!spinTimer) spinTimer = setInterval(() => { spinIdx++; redraw(); }, 120);
      } else if (spinTimer) {
        clearInterval(spinTimer); spinTimer = null;
      }
      redraw();
    },
    question(q, cb) { mode = 'question'; questionText = q; questionCb = cb; text = ''; cursor = 0; resetPaletteState(); redraw(); },
    cancelQuestion() { if (mode === 'question') { mode = 'input'; questionText = ''; questionCb = null; text = ''; cursor = 0; redraw(); } },
    close,
    on(ev, fn) { handlers[ev] = fn; return rl; },
    // test / introspection hooks
    _state: () => ({ text, cursor, mode, history: [...history], busy: busyLabel, palette: paletteItems().map((i) => i.name) }),
  };

  rl.install = function install() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    // capture the ORIGINAL write BEFORE patching — the renderer's own writes
    // go through it and can never recurse through the print-above patch
    const origWrite = process.stdout.write.bind(process.stdout);
    const rout = {
      get columns() { return process.stdout.columns || 80; },
      write: (s) => origWrite(s),
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
    origWrite('\x1b[?25l'); // hide the hardware cursor — the box draws its own block cursor
  };

  return rl;
}
