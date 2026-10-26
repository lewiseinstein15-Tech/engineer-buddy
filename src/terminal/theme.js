// theme.js — AURORA: the semantic color language for Buddy's stream (v0.29.0).
//
// Claude Code paints with one crayon (coral) and wins on restraint. Aurora
// answers with a full spectrum where COLOR CARRIES MEANING — syntax
// highlighting for agency:
//
//   hue    = what kind of thing is happening   (bash=green, read=blue,
//                                               write=violet, git=orange,
//                                               web=cyan, plan=magenta,
//                                               agent=amber, mcp=teal)
//   glyph  = what happened                     (▸ ▤ ✎ ⎇ ◉ ☑ ⧉ ⚙ ⇄)
//   mark   = how it ended                       (✓ ok / ✗ failed / ✗ denied)
//
// Plus the animated aurora edge: a green→cyan→violet gradient rail that
// sweeps while the brain streams, and a verb state machine
// (thinking → forming → streaming → verifying) replacing the static
// "working" label.
//
// Degradation contract (non-negotiable, same as ui.js):
//   256/truecolor → 16-color fallback → mono identity.
//   NO_COLOR=1 or non-TTY resolves to 'none'; /theme mono forces 'none'.
// Every painter checks the level AT CALL TIME, so theme switches are live.

import { strWidth } from './text.js';

// ── Color capability ─────────────────────────────────────────────────────────

export function colorLevel(env = process.env, isTTY = process.stdout?.isTTY) {
  if (env.NO_COLOR === '1') return 'none';
  // FORCE_COLOR (industry standard): force colors on even without a TTY —
  // CI logs, `buddy -p … | tee`, and test snapshots. 'true'/'2+' → truecolor.
  const fc = env.FORCE_COLOR;
  if (fc !== undefined && fc !== '' && fc !== '0') return fc === 'true' || fc === '2' || fc === '3' ? 'true' : '256';
  if (!isTTY) return 'none';
  const term = String(env.TERM || '');
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' || /truecolor|24bit/.test(term)) return 'true';
  if (/256colou?r/.test(term)) return '256';
  return '16';
}

let LEVEL = colorLevel();

/** Force the level (ui.js setTheme calls this; 'none' = mono). */
export function setLevel(level) {
  LEVEL = level === 'none' || level === '16' || level === '256' || level === 'true' ? level : colorLevel();
}
export function getLevel() {
  return LEVEL;
}

/** 256-color foreground painter with a 16-color fallback and mono identity. */
export function hue(n256, fb16) {
  return (s) => {
    const str = String(s ?? '');
    if (LEVEL === 'none') return str;
    if (LEVEL === 'true' || LEVEL === '256') return `\x1b[38;5;${n256}m${str}\x1b[0m`;
    return `\x1b[${fb16}m${str}\x1b[0m`;
  };
}

// ── Semantic painters ────────────────────────────────────────────────────────

export const SEM = {
  narrate: hue(177, 35),   // violet  — the mind speaking (narration, user echo)
  ok:      hue(114, 32),   // green   — success marks
  bad:     hue(203, 31),   // red     — failures / denials
  warn:    hue(179, 33),   // amber   — warnings, agent lifecycle
  time:    hue(245, 90),   // dim     — durations, telemetry
  edge:    hue(81, 36),    // default aurora edge (overridden per tick)
  brand:   hue(80, 36),    // cyan-teal — Buddy identity accents
};

// ── Tool families: hue = what, glyph = what ─────────────────────────────────
// Every tool maps to ONE family color + glyph, so a 40-step agentic run
// scans like a color-coded flamegraph. Unknown / mcp__* tools → teal ⇄.

const F = {
  shell: { hue: 114, fb: 32 }, // green
  read:  { hue: 75,  fb: 36 }, // sky blue
  write: { hue: 177, fb: 35 }, // violet
  git:   { hue: 209, fb: 33 }, // orange
  web:   { hue: 80,  fb: 36 }, // cyan
  plan:  { hue: 213, fb: 35 }, // magenta
  agent: { hue: 179, fb: 33 }, // amber
  test:  { hue: 120, fb: 32 }, // mint
  mcp:   { hue: 73,  fb: 36 }, // teal
};

const FAMILY_OF = {
  bash: 'shell', test: 'test',
  fs_read: 'read', read_file: 'read', fs_search: 'read', fs_list: 'read', glob: 'read',
  symbol_search: 'read', go_to_def: 'read', lsp_goto_def: 'read', find_refs: 'read',
  lsp_refs: 'read', impact: 'read', lsp_diagnostics: 'read',
  fs_write: 'write', write_file: 'write', fs_replace: 'write', replace_in_file: 'write',
  multi_edit: 'write', fs_append: 'write',
  git: 'git', git_write: 'git',
  web_search: 'web', web_fetch: 'web', http: 'web',
  todo: 'plan', exit_plan: 'plan', skill: 'plan',
  task: 'agent', background: 'agent',
};

const GLYPH_OF = {
  shell: '▸', read: '▤', write: '✎', git: '⎇', web: '◉',
  plan: '☑', agent: '⧉', test: '⚙', mcp: '⇄',
};

/** Style for one tool: { family, glyph, paint } — paint is the hue painter. */
export function toolStyle(tool) {
  const name = String(tool ?? '').trim();
  const family = FAMILY_OF[name] || (name.startsWith('mcp__') ? 'mcp' : 'mcp');
  const f = F[family];
  return { family, glyph: GLYPH_OF[family], paint: hue(f.hue, f.fb) };
}

// ── The verb state machine (replaces the static "working" label) ────────────

export const VERBS = {
  thinking:  { v: 'thinking',  paint: hue(141, 35) }, // violet — nothing decodable yet
  forming:   { v: 'forming',   paint: hue(177, 35) }, // violet — a tool call is being typed
  streaming: { v: 'streaming', paint: hue(114, 32) }, // green  — words are landing
  verifying: { v: 'verifying', paint: hue(179, 33) }, // amber  — message closed, wrapping up
};

/** Pure: which verb does the extractor snapshot imply? */
export function pickVerb(snap) {
  if (!snap) return VERBS.thinking;
  if (snap.tool) return VERBS.forming;
  if (snap.messageClosed) return VERBS.verifying;
  if (snap.message && String(snap.message).trim()) return VERBS.streaming;
  return VERBS.thinking;
}

// ── Aurora sweep — the animated gradient rail ───────────────────────────────
// green → mint → cyan → sky → blue → violet, 18 stops, cycles forever.

const SWEEP = [114, 115, 116, 120, 121, 122, 80, 80, 81, 81, 75, 75, 111, 111, 141, 141, 177, 176];

/** Painter for the edge rail: sweeps with the tick, offset per strip line. */
export function auroraEdge(tick = 0, line = 0) {
  const n = SWEEP[(tick * 3 + line * 5) % SWEEP.length];
  return hue(n, 36)('▐');
}

// ── Small pure formatters ────────────────────────────────────────────────────

/** Human duration: 850ms / 4.2s / 1m06s (theme-local twin of ui.formatMs). */
export function fmtDur(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/** Human token estimate: 0 → '0', 1400 → '1.4k', 1250000 → '1.2M'. */
export function fmtTok(bytes) {
  const n = Math.max(0, Math.floor((Number(bytes) || 0) / 4));
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function oneLine(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Word-wrap plain text to `width` visible columns. Pure (unit-tested).
 *  A single overlong word is kept intact (the painter truncates it later). */
export function wrapWords(s, width) {
  const w = Math.max(8, Number(width) || 40);
  const words = String(s ?? '').split(/\s+/).filter(Boolean);
  const rows = [];
  let row = '';
  for (const word of words) {
    const cand = row ? `${row} ${word}` : word;
    if (strWidth(cand) > w && row) {
      rows.push(row);
      row = word;
    } else {
      row = cand;
    }
  }
  if (row) rows.push(row);
  return rows;
}

// ── The Aurora strip — the live 3-line narration panel ──────────────────────
// Replaces v0.28's single dim thought line. Pure: state → string[], painted
// inside buildFrame so the spin timer animates the gradient for free.
//
//   ▐ ✻ streaming  "researching Kimi 3.1 capabilities…"     ← words land live
//   ▐ ▸ bash {"command":"npm te…                            ← tool being formed
//   ▐ ↓ 1.4k tok · 3 tools · 46s                            ← telemetry
//
// Lines disappear when there is nothing to say (empty message, no tool yet)
// so the strip breathes instead of showing empty rails.

// ── Expanded narration (v0.30.0, ctrl+o) ────────────────────────────────────
// Collapsed (default) the strip narrates on ONE width-capped line. Expanded
// (ctrl+o — "show the transcript"), the words wrap into a mini transcript of
// up to 3 rows and the LAST rows win, so the newest words of a long stream
// stay on screen instead of vanishing behind an ellipsis. Pure: the caller
// (inputbox buildFrame) passes verbose = state of the ctrl+o toggle.

const NARRATION_ROWS = 3;

export function buildAuroraStrip({ snap, ms = 0, bytes = 0, cols = 80, tick = 0, toolCalls = 0, verbose = false } = {}) {
  if (!snap) return [];
  const room = Math.max(24, Math.floor(cols) - 6);
  const lines = [];

  const verb = pickVerb(snap);
  const words = snap.message ? oneLine(snap.message, room) : '';
  if (words) {
    const textCap = Math.max(12, room - 26); // row 1 carries `▐ ✻ verb · "` + quote
    if (verbose) {
      // Tail-first: the newest words are the news, so cut the message to the
      // last ~NARRATION_ROWS × textCap chars at a word boundary BEFORE
      // wrapping (oneLine would keep the HEAD — useless for a live tail).
      const budget = textCap * NARRATION_ROWS;
      let tail = String(snap.message ?? '').replace(/\s+/g, ' ').trim();
      if (tail.length > budget) {
        tail = tail.slice(-budget);
        const sp = tail.indexOf(' ');
        if (sp > 0) tail = tail.slice(sp + 1); // drop the partial word at the cut
      }
      const rows = wrapWords(tail, textCap).slice(-NARRATION_ROWS);
      rows.forEach((row, i) => {
        const body = truncateVisible(row, textCap) + (i === rows.length - 1 && snap.messageClosed ? '"' : '');
        if (i === 0) {
          lines.push(`${auroraEdge(tick, 0)} ${verb.paint(`✻ ${verb.v}`)} ${SEM.time('·')} ${SEM.narrate(`"${body}`)}`);
        } else {
          lines.push(`${auroraEdge(tick, i)} ${SEM.time('⌄')} ${SEM.narrate(body)}`);
        }
      });
    } else {
      lines.push(`${auroraEdge(tick, 0)} ${verb.paint(`✻ ${verb.v}`)} ${SEM.time('·')} ${SEM.narrate(`"${truncateVisible(words, room - 24)}"`)}`);
    }
  }
  const narr = lines.length;

  if (snap.tool) {
    const st = toolStyle(snap.tool);
    const raw = oneLine(snap.raw ?? '', room);
    const argsTail = raw.replace(new RegExp(`^\\s*\\{?\\s*"tool"\\s*:\\s*"${String(snap.tool).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), '').replace(/^[\s,:]*/, '');
    const body = `${st.paint(st.glyph)} ${st.paint(String(snap.tool))}${argsTail ? ` ${SEM.time(oneLine(argsTail, Math.max(8, room - String(snap.tool).length - 4)))}` : ''}`;
    lines.push(`${auroraEdge(tick, narr)} ${truncateVisible(body, room)}`);
  }

  if (!lines.length) return []; // raw JSON prefix with no signal — stay quiet

  const tele = `↓ ${fmtTok(bytes)} tok · ${toolCalls} tool call${toolCalls === 1 ? '' : 's'} · ${fmtDur(ms)}`;
  lines.push(`${auroraEdge(tick, narr + (snap.tool ? 0 : 1))} ${SEM.time(truncateVisible(tele, room))}`);
  return lines;
}

/** Visible-width truncate that preserves ANSI codes (theme-local twin). */
export function truncateVisible(s, max) {
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
    w += strWidth(str[i]);
  }
  return out + '…';
}

// ── The done ribbon — how the turn ended, at a glance ───────────────────────
//   ● Done — 3 steps · 4 tool calls · 12.4s · ↓2.1k tok        (green: clean)
//   ● Done — 4 steps · 1 denied · 8.1s                          (amber: blocked)
//   ● Done — 2 steps · 1 failed · 3.3s                          (red: errors)

export function renderDoneRibbon({ steps = 0, tools = 0, ms = 0, bytes = 0, denied = 0, errors = 0, indent = '' } = {}) {
  const paint = errors > 0 ? SEM.bad : denied > 0 ? SEM.warn : SEM.ok;
  const bits = [
    `${steps} step${steps === 1 ? '' : 's'}`,
    tools > 0 ? `${tools} tool call${tools === 1 ? '' : 's'}` : null,
    denied > 0 ? `${denied} denied` : null,
    errors > 0 ? `${errors} failed` : null,
    fmtDur(ms),
    bytes > 0 ? `↓ ${fmtTok(bytes)} tok` : null,
  ].filter(Boolean);
  return `${indent}${paint('●')} ${paint('Done')} ${SEM.time('—')} ${SEM.time(bits.join(' · '))}`;
}
