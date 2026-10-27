// toolcards.js — better tool cards (v0.33.0): the pure half.
//
// The v0.29 card kept the HEAD of a long observation and dropped the tail —
// but test runners, compilers and linters print their verdict at the END
// (the failing test name, the error summary). A 31-line failing npm run
// showed its first 5 lines and hid exactly the lines that matter. This
// module fixes the collapse policy and adds the clipboard affordance:
//
//   select  — pickLines(): <= SHOW_ALL lines → everything; medium → head
//             window (today's shape); long → head + hidden note + TAIL,
//             because tails carry verdicts. Returns data, not paint —
//             ui.js renderObservation stays the only painter.
//   copy    — osc52(): the zero-dependency clipboard. OSC 52 is consumed
//             by the terminal emulator itself (iTerm2, kitty, WezTerm,
//             alacritty, foot, tmux with set-clipboard on) — no native
//             module, no child process, works over SSH. NOTE for callers:
//             the renderer's print() holds unterminated chunks in its
//             pending buffer, so an OSC 52 write MUST carry a trailing
//             newline or it glues onto the next printed card.
//   browse  — formatCopyTable(): `/copy` lists the observation register
//             (newest = 1, /rewind numbering) so the index in the card
//             hint and the index in the table can never disagree.
//
// Degradation: pure string data — the mono/no-color contract lives in the
// painter, as everywhere else.

export const CARDS = {
  SHOW_ALL: 5,    // ≤ this many lines: show them all (v0.29 behavior)
  HEAD_ONLY: 10,  // ≤ this: show the head window, plain "+N more" note
  HEAD: 2,        // long observations: keep this many head lines…
  TAIL: 2,        // …and this many tail lines (the verdict lives here)
  REGISTER_MAX: 10,   // /copy remembers the last N observations
  COPY_MAX: 100000,   // terminals ignore huge OSC 52 payloads — cap honestly
  // ctrl+o expanded cards (v0.30 contract: up to 24 lines). Beyond 24 the
  // same head+tail logic applies proportionally — a verbose card must never
  // show LESS than its collapsed twin.
  VERBOSE_SHOW: 24,
  VERBOSE_HEAD: 12,
  VERBOSE_TAIL: 6,
};

/**
 * Collapse policy for one observation. Pure.
 * lines: string[] (already split). opts: { showAll, headOnlyMax, head, tail }.
 * Returns { kind: 'all'|'head'|'headtail', shown: string[], hidden: number }.
 * `shown` holds the lines to paint; `hidden` counts what the note mentions.
 */
export function pickLines(lines, { showAll = CARDS.SHOW_ALL, headOnlyMax = CARDS.HEAD_ONLY, head = CARDS.HEAD, tail = CARDS.TAIL } = {}) {
  const arr = Array.isArray(lines) ? lines : [];
  if (arr.length <= showAll) return { kind: 'all', shown: arr.slice(), hidden: 0 };
  if (arr.length <= headOnlyMax) {
    return { kind: 'head', shown: arr.slice(0, showAll), hidden: arr.length - showAll };
  }
  const h = Math.max(1, Math.min(head, arr.length - 1));
  const t = Math.max(1, Math.min(tail, arr.length - h));
  const shown = [...arr.slice(0, h), ...arr.slice(arr.length - t)];
  return { kind: 'headtail', shown, hidden: arr.length - h - t };
}

/** The hint line under a collapsed card. Pure (paint-neutral text). */
export function collapseHint(hidden, kind, obsIndex = null) {
  if (hidden <= 0) return '';
  if (kind === 'headtail') {
    const copy = Number.isInteger(obsIndex) && obsIndex > 0 ? ` · /copy ${obsIndex} for all` : '';
    return `… +${hidden} hidden lines — the tail is kept (verdicts live there)${copy} · ctrl+o expands`;
  }
  const copy = Number.isInteger(obsIndex) && obsIndex > 0 ? ` · /copy ${obsIndex} for the full output` : '';
  return `… +${hidden} more lines${copy}`;
}

// ── Clipboard (OSC 52) ───────────────────────────────────────────────────────

/** true when the text fits the OSC 52 payload cap. */
export function copyFits(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8') <= CARDS.COPY_MAX;
}

/**
 * The OSC 52 clipboard escape for `text`. Pure.
 * Wire shape: ESC ] 52 ; c ; <base64-utf8> BEL. The emulator reads it
 * straight off the wire — nothing is rendered, nothing scrolls.
 * Throws on oversized payloads (callers refuse with copyFits() first).
 */
export function osc52(text) {
  const s = String(text ?? '');
  if (!copyFits(s)) throw new Error(`payload too large for OSC 52 (${Buffer.byteLength(s, 'utf8')} bytes > ${CARDS.COPY_MAX})`);
  return `\x1b]52;c;${Buffer.from(s, 'utf8').toString('base64')}\x07`;
}

/** Human byte size: 850 → '850 B', 2400 → '2.3 kB', 1200000 → '1.2 MB'. */
export function fmtBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1000) return `${v} B`;
  if (v < 1000000) return `${(v / 1000).toFixed(1)} kB`;
  return `${(v / 1000000).toFixed(1)} MB`;
}

// ── The /copy register table ─────────────────────────────────────────────────

/**
 * Rows for `/copy` (the observation register). Pure.
 * register: newest-first [{ tool, text, denied, at }].
 * Returns [[n, tool, size, denied, first-line], …] for renderTable.
 * The number IS the position (newest = 1) — never a stored field, so it
 * can never disagree with resolveCopyRef.
 */
export function formatCopyTable(register = []) {
  return (Array.isArray(register) ? register : []).map((r, i) => {
    const first = String(r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 48);
    return [
      String(i + 1),
      String(r.tool ?? '?').slice(0, 12),
      fmtBytes(Buffer.byteLength(String(r.text ?? ''), 'utf8')),
      r.denied ? 'denied' : '',
      first + (first.length >= 48 ? '…' : ''),
    ];
  });
}

/** Resolve `/copy <ref>` against the register. Pure. Refs: '1'..'N', 'reply'.
 * Returns { entry, n } | { error } — newest = 1, /rewind numbering. */
export function resolveCopyRef(register, ref) {
  const list = Array.isArray(register) ? register : [];
  const t = String(ref ?? '').trim().toLowerCase();
  if (!t) return { error: 'usage: /copy <n> — /copy alone lists the register · /copy reply copies Buddy\'s last reply' };
  if (t === 'reply' || t === 'say') {
    const idx = list.findIndex((r) => r.tool === 'say');
    if (idx < 0) return { error: 'no reply yet this session — Buddy\'s last answer lands in the register as it happens' };
    return { entry: list[idx], n: idx + 1 };
  }
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > list.length) {
    return { error: list.length ? `no observation #${t} — the register holds 1-${list.length} (newest = 1)` : 'the register is empty — run a task first' };
  }
  return { entry: list[n - 1], n };
}
