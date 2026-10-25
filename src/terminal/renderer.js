// renderer.js — mini-Ink: the Claude Code / Ink rendering model, zero deps.
//
// How Claude Code's terminal UI actually works (and what v0.5.x got wrong):
//
//   1. The terminal is split into two regions.
//        STATIC  — messages, tool cards, replies. Printed ONCE above the
//                  dynamic region, they scroll into scrollback and are
//                  never touched again.
//        DYNAMIC — the bottom block (input box + status footer). Redrawn
//                  IN PLACE: cursor up exactly as many SCREEN ROWS as the
//                  previous frame occupied, erase down, write new frame.
//
//   2. There is exactly ONE writer. Application code never writes to the
//      terminal directly — every print goes through print(), which erases
//      the frame, writes the content, and re-anchors the frame below it.
//      Two writers racing for the cursor is what corrupted the v0.5.x box.
//
//   3. Height is measured in wrapped SCREEN ROWS, not logical lines. A
//      100-char line on an 80-col terminal is 2 rows. CJK is 2 columns.
//      Under-counting rows is what left ghost boxes behind.
//
// Frames are rebuilt from state on every change (the React/Ink model):
// cheap because a frame is ~6 lines, and correct because nothing is ever
// incrementally patched.

import { rowCount } from './text.js';

export function createRenderer({ out, frame = null } = {}) {
  let frameRows = 0;   // screen rows currently occupied by the dynamic frame
  let closed = false;
  let pending = '';    // partial line held until a newline arrives

  const cols = () => Math.max(20, (out.columns ?? process.stdout?.columns) || 80);

  function erase() {
    if (frameRows <= 0) return;
    // cursor sits somewhere on the LAST row of the frame
    out.write('\r');                                          // column 1
    if (frameRows > 1) out.write(`\x1b[${frameRows - 1}A`);   // up to frame top
    out.write('\x1b[J');                                      // erase down
    frameRows = 0;
  }

  function draw() {
    if (closed || typeof frame !== 'function') return;
    const lines = frame(cols());
    if (!Array.isArray(lines) || lines.length === 0) return;
    const text = lines.join('\n');
    out.write(text);
    frameRows = rowCount(text, cols());
  }

  /** Re-render the dynamic region in place (state changed). */
  function render() {
    if (closed) return;
    erase();
    draw();
  }

  /** Static content: printed above the frame, which is re-anchored below. */
  function print(chunk) {
    if (closed) return;
    pending += String(chunk ?? '');
    if (!pending.includes('\n')) return; // hold partial lines until newline
    const text = pending;
    pending = '';
    erase();
    out.write(text.endsWith('\n') ? text : text + '\n');
    draw();
  }

  /** Erase the frame but remember nothing (screen clear, etc.). */
  function clear() {
    if (closed) return;
    erase();
    pending = '';
  }

  /** Leave the TUI: erase frame, restore the terminal cursor. */
  function close() {
    if (closed) return;
    closed = true;
    pending = '';
    erase();
    out.write('\x1b[?25h');
  }

  return {
    render,
    print,
    clear,
    close,
    get rows() { return frameRows; },
  };
}
