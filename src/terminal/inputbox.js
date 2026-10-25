// inputbox.js — Claude Code-style boxed input panel, zero dependencies.
//
// Replaces the bare `buddy❯` readline prompt with a bordered input box that:
//   - lives at the bottom of the terminal and is redrawn in place
//   - shows live status in its top border (version · gateway · context)
//   - shows a spinner in the border while a turn is running
//   - shows a dim placeholder when empty, and an editing hint in the bottom border
//   - pushes existing output down when new text is printed above it (print-above)
//   - supports history (↑/↓), tab completion for slash commands, esc to clear/interrupt
//
// The facade mirrors the readline.Interface surface the REPL already uses:
//   prompt(), close(), question(q, cb), setPrompt(p), on('line'|'SIGINT'|'close'|'escape')

import readline from 'node:readline';
import { c } from './ui.js';

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

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
  return String(s ?? '').replace(ANSI_RE, '').split('').reduce((w, ch) => w + charWidth(ch), 0);
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

// Key reducer: maps a keypress to an editing action (pure, unit-tested).
// key: { name?, ctrl?, meta?, sequence? } — the node keypress event shape.
// Returns { action, data } where action ∈ insert|submit|backspace|delete|left|right|
// home|end|kill-line|kill-word-before|history-prev|history-next|complete|escape|sigint|eof|null
export function applyKey(key) {
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
  if (name === 'up') return { action: 'history-prev' };
  if (name === 'down') return { action: 'history-next' };
  if (name === 'tab') return { action: 'complete' };
  const seq = key.sequence ?? '';
  if (!key.ctrl && !key.meta && seq >= ' ' && !seq.startsWith('\x1b')) {
    return { action: 'insert', data: seq };
  }
  return { action: null };
}

// ── Spinner frames (braille) ─────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── The box ──────────────────────────────────────────────────────────────────

export function createInputBox({
  title = 'Buddy',
  placeholder = '',
  hint = '',
  statusRight = null,   // () => string
  completer = null,     // (line) => string[] (full candidates)
  historySize = 400,
  maxContentLines = 8,
} = {}) {
  let buffer = '';
  let cursor = 0;
  let mode = 'input';            // 'input' | 'question' | 'closed'
  let questionText = '';
  let questionCb = null;
  let busyLabel = null;          // string while a turn is running
  let frame = 0;
  let prevH = 0;
  let multiline = false;
  const history = [];
  let histIdx = -1;
  let draft = '';
  const handlers = {};
  let spinTimer = null;

  const cols = () => Math.max(38, Math.min(process.stdout.columns || 80, 120) - 2); // 2-col safety margin: never touch the last columns

  // Internal writes go through this reference. install() rebinds it to the
  // ORIGINAL stdout write so box rendering can never recurse through the
  // print-above patch (redraw -> patchedWrite -> redraw -> ...).
  let write = (s) => process.stdout.write(s);

  // NOTE: inverse-video cursor rendering is integrated into the first content line
  // by re-rendering it with the cursor applied; kept simple for reliability.
  function renderBoxLinesFinal() {
    const W = cols();
    const inner = W - 4;
    const lines = [];

    let right = '';
    if (busyLabel) right = `${FRAMES[frame % FRAMES.length]} ${busyLabel}`;
    else if (statusRight) right = statusRight();
    right = c.dim(right);
    const left = c.bold(c.cyan(` ${title} `));
    const leftW = strWidth(` ${title} `);
    const rightW = strWidth(right);
    const fill = Math.max(1, W - 2 - leftW - rightW - 2);
    lines.push(`╭─${left}${'─'.repeat(fill)}${right}─╮`);

    // content with cursor
    let shown;
    if (mode === 'question') {
      shown = wrapContent(questionText, inner).map((l) => c.dim(l));
      shown.push(c.bold(cursorBlock('')));
    } else if (buffer === '') {
      shown = [c.dim(c.gray(placeholder)) + c.bold(cursorBlock(''))];
    } else {
      const wrapped = wrapContent(buffer, inner);
      // map absolute cursor to wrapped position
      let remaining = cursor;
      let li = 0; let ci = 0;
      for (let i = 0; i < wrapped.length; i++) {
        const wLen = strWidth(wrapped[i]);
        if (remaining <= wLen || i === wrapped.length - 1) { li = i; ci = remaining; break; }
        remaining -= wLen;
      }
      const total = wrapped.length;
      let windowStart = 0;
      if (total > maxContentLines) windowStart = Math.max(0, Math.min(li - Math.floor(maxContentLines / 2), total - maxContentLines));
      const win = wrapped.slice(windowStart, windowStart + maxContentLines);
      const liRel = li - windowStart;
      shown = win.map((l, i) => {
        if (i !== liRel) return l;
        const chars = Array.from(l);
        let w = 0; let idx = chars.length;
        for (let j = 0; j < chars.length; j++) {
          if (w + charWidth(chars[j]) > ci) { idx = j; break; }
          w += charWidth(chars[j]);
        }
        const head = chars.slice(0, idx).join('');
        const at = chars[idx] ?? ' ';
        const tail = chars.slice(idx + (chars[idx] !== undefined ? 1 : 0)).join('');
        return head + c.inverse(at) + tail;
      });
    }
    for (const cl of shown) {
      const pad = Math.max(0, inner - strWidth(cl));
      lines.push(`│ ${cl}${' '.repeat(pad)} │`);
    }

    const hintText = c.dim(hint);
    const hintW = strWidth(hint);
    const fill2 = Math.max(1, W - 2 - hintW - 2);
    lines.push(`╰─${hintText}${'─'.repeat(fill2)}─╯`);
    return lines;
  }

  function cursorBlock(ch) { return c.inverse(ch || ' '); }

  function redraw() {
    if (mode === 'closed') return;
    const lines = renderBoxLinesFinal();
    if (prevH > 0) write(`\x1b[${prevH}A\r\x1b[J`);
    write(lines.join('\r\n'));
    prevH = lines.length;
  }

  function clearForPrint() {
    if (prevH > 0 && mode !== 'closed') {
      write(`\x1b[${prevH}A\r\x1b[J`);
      prevH = 0;
    }
  }

  // print-above: everything the app console.logs is caught by the stdout
  // interception installed by install(), so the box never gets split.

  function submitLine() {
    const text = buffer;
    const wasQuestion = mode === 'question';
    buffer = ''; cursor = 0; multiline = false;
    if (!wasQuestion) {
      if (text.trim() && history[0] !== text) history.unshift(text);
      if (history.length > historySize) history.pop();
    }
    histIdx = -1; draft = '';
    clearForPrint();
    const cb = questionCb;
    if (wasQuestion) { mode = 'input'; questionText = ''; questionCb = null; cb(text); return; }
    handlers.line?.(text);
  }

  function complete() {
    if (!completer || !buffer.startsWith('/') || buffer.includes(' ')) return;
    const candidates = completer(buffer);
    if (!candidates.length) return;
    if (candidates.length === 1) {
      buffer = candidates[0] + ' '; cursor = buffer.length;
      return;
    }
    // longest common prefix
    let lcp = candidates[0];
    for (const cand of candidates) {
      while (!cand.startsWith(lcp)) lcp = lcp.slice(0, -1);
    }
    if (lcp !== buffer) { buffer = lcp; cursor = buffer.length; return; }
    clearForPrint();
    console.log(c.dim('  ' + candidates.join('  ')));
  }

  function onKeypress(key) {
    if (mode === 'closed') return;
    const { action, data } = applyKey(key || {});
    switch (action) {
      case 'insert': buffer = buffer.slice(0, cursor) + data + buffer.slice(cursor); cursor += data.length; break;
      case 'backspace': if (cursor > 0) { buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor); cursor--; } break;
      case 'delete': buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1); break;
      case 'left': if (cursor > 0) cursor--; break;
      case 'right': if (cursor < buffer.length) cursor++; break;
      case 'home': cursor = 0; break;
      case 'end': cursor = buffer.length; break;
      case 'kill-line': buffer = buffer.slice(0, cursor); break;
      case 'kill-word-before': {
        const before = buffer.slice(0, cursor).replace(/\S*\s*$/, '');
        buffer = before + buffer.slice(cursor);
        cursor = before.length;
        break;
      }
      case 'history-prev':
        if (mode === 'input' && history.length) {
          if (histIdx === -1) draft = buffer;
          histIdx = Math.min(histIdx + 1, history.length - 1);
          buffer = history[histIdx]; cursor = buffer.length;
        }
        break;
      case 'history-next':
        if (mode === 'input' && histIdx !== -1) {
          histIdx--;
          if (histIdx === -1) { buffer = draft; }
          else buffer = history[histIdx];
          cursor = buffer.length;
        }
        break;
      case 'complete': complete(); break;
      case 'submit': submitLine(); return; // submitLine handles its own repaint
      case 'escape':
        if (mode === 'question') return; // Ctrl+C owns deny; esc keeps the question
        if (busyLabel) { handlers.escape?.(); return; }
        if (buffer) { buffer = ''; cursor = 0; multiline = false; }
        break;
      case 'sigint': handlers.SIGINT?.(); return;
      case 'eof':
        if (!buffer) { close(); return; }
        break;
      default: return; // unhandled key: no repaint needed
    }
    redraw();
  }

  function close() {
    if (mode === 'closed') return;
    if (spinTimer) clearInterval(spinTimer);
    clearForPrint();
    mode = 'closed';
    write('\x1b[?25h'); // terminal cursor back on
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* not a tty */ }
    process.stdin.removeListener('keypress', onKeypress);
    process.stdout.removeListener('resize', onResize);
    handlers.close?.();
  }

  function onResize() { if (mode !== 'closed') redraw(); }

  const rl = {
    prompt() { redraw(); },
    setPrompt() { /* kept for readline API compatibility; box owns its labels */ },
    setBusy(label) {
      busyLabel = label || null;
      if (busyLabel && !spinTimer) {
        spinTimer = setInterval(() => { frame++; redraw(); }, 110);
      }
      if (!busyLabel && spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      redraw();
    },
    question(q, cb) { mode = 'question'; questionText = q; questionCb = cb; buffer = ''; cursor = 0; redraw(); },
    cancelQuestion() { if (mode === 'question') { mode = 'input'; questionText = ''; questionCb = null; buffer = ''; cursor = 0; redraw(); } },
    close,
    on(ev, fn) { handlers[ev] = fn; return rl; },
    // test / introspection hooks
    _state: () => ({ buffer, cursor, mode, history: [...history], multiline }),
  };

  rl.install = function install() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', (_ch, key) => onKeypress(key || { sequence: _ch }));
    process.stdout.on('resize', onResize);

    // print-above: intercept ALL stdout writes so printed output pushes the box down
    const origWrite = process.stdout.write.bind(process.stdout);
    write = origWrite; // box internals bypass the patch — recursion-proof
    process.stdout.write = function patchedWrite(chunk, ...rest) {
      if (mode !== 'closed') clearForPrint();
      const res = origWrite(chunk, ...rest);
      if (mode !== 'closed') redraw();
      return res;
    };
    rl._origWrite = origWrite;
    redraw();
    write('\x1b[?25l'); // hide the terminal cursor — the box draws its own block cursor
  };

  return rl;
}
