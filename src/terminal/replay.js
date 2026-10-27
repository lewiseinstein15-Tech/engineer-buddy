// replay.js — replayable narration (v0.37.0): watch any past session
// step-by-step, paced from its own timestamps.
//
// The session JSONL (.buddy/sessions/*.jsonl) is already a flight recorder:
// one event per line, ISO-stamped, append-only. What it never had is a
// PLAYER. This module is that player, split the usual Buddy way:
//
//   pure half  — loadEvents / buildTimeline / replaySummary / frameText:
//                timeline math and frame text, fully testable, no TTY.
//   live half  — playReplay: raw-mode key handling (space pause · n next ·
//                [ ] speed · q quit) and the paced paint loop.
//
// Pacing (the honest-movie rule): gaps between events come from the session's
// own `at` timestamps — the replay reproduces the RHYTHM of the original run
// (a tool call lands right after its brain call; a long think shows as a
// pause) — but compressed and clamped, because a replay that takes as long
// as the session is a documentary nobody finishes.

import fs from 'node:fs';
import { renderToolEvent, renderTodo, c, PALETTE } from './ui.js';
import { renderMarkdown } from './markdown.js';

export const PACING = {
  MAX_GAP_MS: 4000,  // any single real gap compresses to at most this…
  MIN_GAP_MS: 150,   // …and never under this (frames must not strobe)
  PACE: 0.35,        // replay time = 35% of wall time, then clamped
  SPEEDS: [0.5, 1, 2, 4, 8], // [ / ] cycle through these
};

const NARRATABLE = new Set(['user', 'say', 'tool', 'shell', 'compaction', 'interrupted', 'error']);

/** Load a session JSONL tolerantly: one corrupt line never kills the film.
 *  Returns { events, error } — error is a string only when the file is
 *  unreadable or holds no parseable JSONL at all. */
export function loadEvents(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { events: [], error: `cannot read ${file}: ${e.message}` };
  }
  const events = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object') events.push(e);
    } catch {
      /* torn or foreign line — skip, keep rolling */
    }
  }
  if (!events.length) return { events: [], error: `no replayable events in ${file}` };
  return { events, error: null };
}

/** Total painted-pause time of a timeline, in ms (the status-line label).
 *  Exported because the drill pinned the unit bug: fmtClock eats ms — hand it
 *  the raw sum, never a pre-divided number. */
export function timelineMs(frames) {
  return (Array.isArray(frames) ? frames : []).reduce((a, f) => a + (Number(f?.delayMs) || 0), 0);
}

/** Clamp one inter-event delay. Clock skew (at[i] < at[i-1]) and missing
 *  stamps both fall back to MIN_GAP_MS — the film keeps a steady beat. */
export function clampGap(deltaMs, { pace = PACING.PACE, maxGapMs = PACING.MAX_GAP_MS, minGapMs = PACING.MIN_GAP_MS } = {}) {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return minGapMs;
  return Math.max(minGapMs, Math.min(maxGapMs, Math.round(deltaMs * pace)));
}

/** Build the replay timeline: narratable events in file order, each with a
 *  delayMs = how long to pause BEFORE painting it (first frame: 0).
 *  Unknown event types (future versions) are skipped, not crashed on. */
export function buildTimeline(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const frames = [];
  let prevAt = null;
  for (const ev of list) {
    if (!ev || typeof ev !== 'object' || !NARRATABLE.has(ev.type)) continue;
    const at = Date.parse(ev.at);
    const delta = prevAt != null && Number.isFinite(at) ? at - prevAt : null;
    frames.push({ ev, delayMs: frames.length === 0 ? 0 : clampGap(delta, opts) });
    if (Number.isFinite(at)) prevAt = at;
  }
  return frames;
}

/** Header stats for a session: what the viewer announces before it plays. */
export function replaySummary(events) {
  const list = Array.isArray(events) ? events : [];
  let turns = 0;
  let tools = 0;
  let denied = 0;
  let says = 0;
  let errors = 0;
  let firstAt = null;
  let lastAt = null;
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const at = Date.parse(e.at);
    if (Number.isFinite(at)) {
      if (firstAt == null || at < firstAt) firstAt = at;
      if (lastAt == null || at > lastAt) lastAt = at;
    }
    if (e.type === 'user') turns += 1;
    else if (e.type === 'tool') {
      tools += 1;
      if (e.denied) denied += 1;
    } else if (e.type === 'say') says += 1;
    else if (e.type === 'error') errors += 1;
  }
  const wallMs = firstAt != null && lastAt != null ? Math.max(0, lastAt - firstAt) : 0;
  return { turns, tools, denied, says, errors, events: list.length, wallMs };
}

function fmtClock(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** The text of one frame — the SAME shapes the live TUI paints
 *  (renderToolEvent cards, markdown says, gray system notes) so a replay
 *  looks like the session felt. Pure: returns a string, no console. */
export function frameText(ev) {
  switch (ev.type) {
    case 'user':
      return [`\n${c.bold('You')}`, String(ev.text ?? ''), ''].join('\n');
    case 'say':
      return [`\n${c.bold('Buddy')}`, renderMarkdown(String(ev.text ?? ''), { color: PALETTE }), ''].join('\n');
    case 'tool': {
      if (ev.tool === 'todo' && Array.isArray(ev.args?.items)) {
        return [renderToolEvent({ ...ev, observation: undefined }), renderTodo(ev.args.items)].join('\n');
      }
      return renderToolEvent(ev, { preview: false });
    }
    case 'shell':
      return `  ${c.gray(`! ${String(ev.command ?? '')}${ev.code != null ? c.gray(` · exit ${ev.code}`) : ''}`)}`;
    case 'compaction':
      return `  ${c.gray(`↺ context compacted (${ev.dropped ?? '?'} messages summarized${ev.auto ? ', auto' : ''})`)}`;
    case 'interrupted':
      return `  ${c.yellow('⏸')} interrupted — nothing lost, say "continue" to resume`;
    case 'error':
      return `  ${c.red('!')} ${String(ev.text ?? '')}`;
    default:
      return '';
  }
}

/**
 * The paced paint loop — the seam the tests drive. For each frame: paint,
 * then wait delayMs/speed. `wait(ms)` is injectable (tests use a stub that
 * resolves immediately and records); `paint(text)` is injectable too.
 * `shouldStop()` is polled between frames (the live player flips it on q).
 * Speed changes apply from the NEXT frame — a pause you can't catch is not
 * a pause.
 */
export async function runPlayback(frames, { paint = () => {}, wait = async () => {}, shouldStop = () => false, getSpeed = () => 1, total = frames.length } = {}) {
  let played = 0;
  let waitedMs = 0;
  for (let i = 0; i < frames.length; i++) {
    if (shouldStop()) break;
    const f = frames[i];
    paint(frameText(f.ev), { index: i + 1, total, kind: f.ev.type });
    played += 1;
    if (f.delayMs > 0) {
      const t0 = Date.now();
      await wait(Math.max(0, Math.round(f.delayMs / Math.max(0.1, getSpeed()))));
      waitedMs += Date.now() - t0;
    }
    if (shouldStop()) break;
  }
  return { played, total, waitedMs };
}

// ── The live player (TTY): keys, pause, speed — the part that breathes ──────

import path from 'node:path';
import readline from 'node:readline';

const sleepTick = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pick the closest supported speed for a CLI-provided multiplier. */
export function nearestSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return PACING.SPEEDS.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), PACING.SPEEDS[0]);
}

/**
 * playReplay(file) — the full-screen-ish player: header, paced frames with a
 * per-frame status line, raw-mode keys (space pause · n next · [ ] speed ·
 * q quit). Piped stdout / non-TTY stdin: plays control-free at 8×.
 * Returns { ok, played, total, error } — the CLI turns that into exit codes.
 */
export async function playReplay({ file, speed = 1, stdin = process.stdin, stdout = process.stdout } = {}) {
  const { events, error } = loadEvents(file);
  if (error) return { ok: false, error };
  const frames = buildTimeline(events);
  if (!frames.length) return { ok: false, error: 'nothing replayable in this session (no user/tool/say events)' };
  const sum = replaySummary(events);
  const interactive = Boolean(stdin.isTTY) && Boolean(stdout?.isTTY !== false);

  let stopped = false;
  let paused = false;
  let skip = false;
  let spd = interactive ? nearestSpeed(speed) : 8;

  const status = (extra = '') => {
    const t = timelineMs(frames);
    stdout.write(
      `${c.gray(`  ─ replay ${idx}/${frames.length} · ${fmtClock(t)} timeline · ${spd}× · space ${paused ? 'resume' : 'pause'} · n next · [ ] speed · q quit ${extra}`)}\n`
    );
  };
  let idx = 0;
  const paint = (text, meta) => {
    idx = meta.index;
    stdout.write(`${text}\n`);
    status();
  };

  // Header — what this film is and what it holds.
  stdout.write(`\n${c.bold('Replay')} ${c.dim(path.basename(file, '.jsonl'))}\n`);
  stdout.write(
    c.gray(
      `  ${sum.turns} turn${sum.turns === 1 ? '' : 's'} · ${sum.tools} tool call${sum.tools === 1 ? '' : 's'}${sum.denied ? ` · ${sum.denied} denied` : ''} · ${sum.says} repl${sum.says === 1 ? 'y' : 'ies'}${sum.errors ? ` · ${sum.errors} error${sum.errors === 1 ? '' : 's'}` : ''} · wall ${fmtClock(sum.wallMs)}\n`
    )
  );
  if (!interactive) stdout.write(c.gray('  (not a TTY — playing control-free at 8×)\n'));

  let removeKeys = () => {};
  if (interactive) {
    readline.emitKeypressEvents(stdin);
    if (stdin.isRaw !== true && stdin.setRawMode) {
      try { stdin.setRawMode(true); } catch { /* already raw or unsupported */ }
    }
    stdin.resume();
    const onKey = (str, key) => {
      const k = key ?? {};
      if (k.ctrl && (k.name === 'c' || k.name === 'd')) { stopped = true; skip = true; return; }
      const ch = String(str ?? '');
      if (ch === 'q' || ch === 'Q' || k.name === 'escape') { stopped = true; skip = true; return; }
      if (ch === ' ') {
        paused = !paused;
        if (paused) stdout.write(`  ${c.yellow('⏸')} paused — space resumes${c.gray(' · n paints the next frame now')}\n`);
        else stdout.write(`  ${c.green('▶')} resumed\n`);
        return;
      }
      if (ch === 'n' || k.name === 'right' || k.name === 'enter') { skip = true; paused = false; return; }
      if (ch === '[' || ch === ']') {
        const i = PACING.SPEEDS.indexOf(spd);
        const next = Math.max(0, Math.min(PACING.SPEEDS.length - 1, i + (ch === ']' ? 1 : -1)));
        spd = PACING.SPEEDS[next];
        stdout.write(`  ${c.gray(`speed ${spd}×`)}\n`);
        return;
      }
    };
    stdin.on('keypress', onKey);
    removeKeys = () => {
      stdin.removeListener('keypress', onKey);
      if (stdin.setRawMode) {
        try { stdin.setRawMode(false); } catch { /* gone already */ }
      }
      stdin.pause();
    };
  }

  try {
    const out = await runPlayback(frames, {
      paint,
      total: frames.length,
      shouldStop: () => stopped,
      getSpeed: () => spd,
      wait: async (ms) => {
        let left = ms;
        skip = false;
        while (left > 0 && !stopped && !skip) {
          if (paused) {
            await sleepTick(50);
            continue;
          }
          const step = Math.min(left, 50);
          await sleepTick(step);
          if (!paused && !skip) left -= step;
        }
      },
    });
    removeKeys();
    stdout.write(
      `\n${c.gray(`  ─ replayed ${out.played}/${out.total} events — the JSONL stays untouched (.buddy/sessions/) ─`)}\n`
    );
    return { ok: true, played: out.played, total: out.total };
  } catch (e) {
    removeKeys();
    return { ok: false, error: e.message };
  }
}
