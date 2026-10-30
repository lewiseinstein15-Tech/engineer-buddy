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
//
// v0.64.0 — THE BLINKING TYPE BOX: render() used to emit erase and frame as
// SEPARATE write() syscalls (three for erase: \r, cursor-up, erase-down).
// The busy spinner repaints at 8 fps, so every 120ms the terminal received
// [blank region] → [frame] as distinct reads — and a terminal (or an SSH
// link, or a loaded machine) that draws what it gets BLINKS the box. The
// fix is the standard Ink discipline: each repaint is ONE write containing
// erase + frame back to back, so the terminal never sees the erased
// intermediate state — plus a skip when the frame text is unchanged, so a
// state churn that paints the same frame costs zero bytes at all.

import { rowCount } from './text.js';

export function createRenderer({ out, frame = null, onPrint = null } = {}) {
  let frameRows = 0;   // screen rows currently occupied by the dynamic frame
  let closed = false;
  let pending = '';    // partial line held until a newline arrives
  let lastFrame = null; // last frame text actually painted (skip identical repaints)

  const cols = () => Math.max(20, (out.columns ?? process.stdout?.columns) || 80);

  /** The erase sequence for the CURRENT frame (caller owns frameRows state). */
  function eraseSeq() {
    if (frameRows <= 0) return '';
    // cursor sits somewhere on the LAST row of the frame
    let s = '\r';                                           // column 1
    if (frameRows > 1) s += `\x1b[${frameRows - 1}A`;       // up to frame top
    s += '\x1b[J';                                          // erase down
    return s;
  }

  function resetFrameState() {
    frameRows = 0;
    lastFrame = null;
  }

  /** Re-render the dynamic region in place (state changed). ONE write. */
  function render() {
    if (closed || typeof frame !== 'function') return;
    const lines = frame(cols());
    if (!Array.isArray(lines) || lines.length === 0) {
      // frame vanished (empty box) — erase what is on screen, paint nothing
      if (frameRows > 0) out.write(eraseSeq());
      resetFrameState();
      return;
    }
    const text = lines.join('\n');
    if (text === lastFrame && frameRows > 0) return; // identical frame — zero bytes
    out.write(eraseSeq() + text); // ONE write: the terminal never sees the blank
    frameRows = rowCount(text, cols());
    lastFrame = text;
  }

  /** Static content: printed above the frame, which is re-anchored below.
   *  onPrint (v0.31.0) sees the exact flushed text — the ctrl+r transcript
   *  captures every scrollback byte through this single choke point. */
  function print(chunk) {
    if (closed) return;
    pending += String(chunk ?? '');
    if (!pending.includes('\n')) return; // hold partial lines until newline
    const text = pending;
    pending = '';
    try { onPrint?.(text); } catch { /* capture is best-effort */ }
    // ONE write: erase + static content + re-anchored frame. Separating these
    // into three writes made every printed line blink the whole bottom block.
    let buf = eraseSeq();
    resetFrameState();
    buf += text.endsWith('\n') ? text : text + '\n';
    if (typeof frame === 'function') {
      const lines = frame(cols());
      if (Array.isArray(lines) && lines.length > 0) {
        const t = lines.join('\n');
        buf += t;
        frameRows = rowCount(t, cols());
        lastFrame = t;
      }
    }
    out.write(buf);
  }

  /** Erase the frame but remember nothing (screen clear, etc.). */
  function clear() {
    if (closed) return;
    if (frameRows > 0) out.write(eraseSeq());
    resetFrameState();
    pending = '';
  }

  /** Leave the TUI: erase frame, restore the terminal cursor. */
  function close() {
    if (closed) return;
    closed = true;
    pending = '';
    if (frameRows > 0) out.write(eraseSeq());
    resetFrameState();
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
