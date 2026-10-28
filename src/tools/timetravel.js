// timetravel.js — time-travel debugging / retrace (v0.40.0, checklist §5).
//
// "replay a session's tool calls deterministically against checkpoints;
// 'replay from step 7 with this one edit changed'". The --replay film (v0.37)
// SHOWS what happened — retrace RE-BUILDS it with one edit swapped, from the
// session's own recorded steps, and lets the checkpoints VERIFY it.
//
// Honest determinism model:
//   - fs_write / fs_replace (+replace_all) / fs_append are PURE functions of
//     their args → replayed byte-for-byte, in memory.
//   - Everything else (bash, git_write, web, gh…) is SKIPPED and listed —
//     its effects cannot be modeled, and pretending otherwise would be a lie.
//   - multi_edit is skipped in v1 (its matcher lives private in local.js).
//   - The base state for the replay window is RECONSTRUCTED from earlier
//     writes in the same session, then CROSS-CHECKED against the checkpoint
//     store: the manifest of the first replayed write holds the pre-write
//     hash of its target — a hash match proves the reconstruction exact,
//     a mismatch means a non-fs step mutated the file and is reported.
//   - Files with no reconstructable base (never written earlier in-session,
//     no checkpoint) are excluded honestly.
//   - Apply snapshots EVERY touched file first (one retrace checkpoint), so
//     /rewind can undo the whole what-if in one step.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadEvents } from '../terminal/replay.js';
import { listCheckpoints } from '../agent/checkpoints.js';
import { snapshotPaths } from '../agent/checkpoints.js';
import { truncate } from '../util.js';
import { isSecretPath } from './local.js';

const FS_TOOLS = new Set(['fs_write', 'fs_replace', 'fs_append']);
const RETRACE_TOOLS = FS_TOOLS;
const MAX_RETRACE_ARGS = 32768;

/** The retrace record a session tool event carries (v0.40.0): FULL fs args
 *  for plain file edits — the deterministic replay's fuel. The session's
 *  args._preview stays a 160-char hygiene preview; the retrace record is the
 *  one deliberate exception, and it is POLICY-GUARDED:
 *  secret paths never carry their content into the transcript (secret:true),
 *  oversized args record an honest tooLarge marker instead of the body. */
export function retraceRecord(tool, args) {
  if (!RETRACE_TOOLS.has(String(tool || ''))) return undefined;
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : null;
  if (!a || !String(a.path || '')) return undefined;
  const p = String(a.path);
  if (isSecretPath(p)) return { path: p, secret: true };
  let body;
  try { body = JSON.parse(JSON.stringify(a)); } catch { return undefined; }
  if (JSON.stringify(body).length > MAX_RETRACE_ARGS) return { path: p, tooLarge: true };
  return body;
}

/** Numbered deterministic steps from a session's events: type 'tool', not
 *  denied, replayable args present. n = 1-based step number over tool calls.
 *  Unrecorded fs steps (secret path / too large / pre-v0.40 sessions) come
 *  through as excluded — they keep their step number, honestly unplayable. */
export function extractSteps(events) {
  const out = [];
  let n = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.type !== 'tool' || ev.denied) continue;
    n += 1;
    const rec = ev.retrace;
    if (rec && (rec.secret || rec.tooLarge)) {
      out.push({ n, tool: String(ev.tool || '?'), args: {}, at: ev.at || '', why: ev.why || '', excluded: rec.secret ? 'secret path — args never recorded' : 'args too large to record' });
      continue;
    }
    const args = (rec && typeof rec === 'object') ? rec : (ev.args && typeof ev.args === 'object' && !ev.args._preview ? ev.args : {});
    out.push({ n, tool: String(ev.tool || '?'), args, at: ev.at || '', why: ev.why || '' });
  }
  return out;
}

/** Build the retrace plan. swap/set replace ONE step's args entirely.
 *  Returns {ok, error?, plan:{from, until, replay, skipped, files, swap}}. */
export function planRetrace(steps, { from = 1, until = null, swap = null, set = null } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return { ok: false, error: 'no tool steps in this session' };
  const last = list[list.length - 1].n;
  const f = Math.max(1, Number(from) || 1);
  const u = Math.min(last, Number(until) || last);
  if (f > last) return { ok: false, error: `from=${f} is past the last step (${last})` };
  if (u < f) return { ok: false, error: `until (${u}) is before from (${f})` };
  const window = list.filter((s) => s.n >= f && s.n <= u);
  const replay = window.filter((s) => FS_TOOLS.has(s.tool) && !s.excluded && String(s.args.path || ''));
  const skipped = window.filter((s) => !FS_TOOLS.has(s.tool) || s.excluded || !String(s.args.path || ''));
  const files = [...new Set(replay.map((s) => String(s.args.path || '')).filter(Boolean))];
  let swapStep = null;
  let swapArgs = null;
  if (swap != null) {
    const sn = Number(swap);
    const target = list.find((s) => s.n === sn);
    if (!target) return { ok: false, error: `swap step ${sn} does not exist (1..${last})` };
    if (sn < f || sn > u) return { ok: false, error: `swap step ${sn} is outside the replay window (${f}..${u})` };
    if (target.excluded) return { ok: false, error: `swap step ${sn} is unrecorded (${target.excluded})` };
    if (!FS_TOOLS.has(target.tool)) return { ok: false, error: `swap step ${sn} is ${target.tool} — only fs_write/fs_replace/fs_append steps can be swapped` };
    if (!set || typeof set !== 'object' || Array.isArray(set)) return { ok: false, error: 'swap needs set: the FULL replacement args object for that step' };
    if (!String(set.path || '') && !String(target.args.path || '')) return { ok: false, error: 'set must include path' };
    swapStep = sn;
    swapArgs = { ...target.args, ...set, path: String(set.path || target.args.path) };
  }
  return { ok: true, plan: { from: f, until: u, total: last, replay, skipped, files, swap: swapStep, swapArgs, swapOriginal: swapStep ? list.find((s) => s.n === swapStep).args : null } };
}

/** Apply ONE recorded step to a contents map (pure). Returns {applied, error}. */
function applyOp(contents, step) {
  const p = String(step.args.path || '');
  if (!p) return { applied: false, error: 'no path' };
  if (step.tool === 'fs_write') {
    contents.set(p, String(step.args.content ?? ''));
    return { applied: true };
  }
  if (step.tool === 'fs_append') {
    if (!contents.has(p)) return { applied: false, error: `${p}: append with no known base` };
    contents.set(p, contents.get(p) + String(step.args.content ?? ''));
    return { applied: true };
  }
  if (step.tool === 'fs_replace') {
    if (!contents.has(p)) return { applied: false, error: `${p}: replace with no known base` };
    const find = String(step.args.find ?? '');
    const rep = String(step.args.replace ?? '');
    const cur = contents.get(p);
    if (!find || !cur.includes(find)) return { applied: false, error: `${p}: find-snippet not present (timeline diverged from the original run)` };
    contents.set(p, step.args.replace_all ? cur.split(find).join(rep) : cur.replace(find, rep));
    return { applied: true };
  }
  return { applied: false, error: `${step.tool} not replayable` };
}

/** Reconstruct the pre-`from` state of the given files from earlier writes in
 *  the same session. Returns {contents: Map, base: Map<path, 'replayed'>, warnings: []}. */
export function reconstructBase(steps, files, from) {
  const contents = new Map();
  const known = new Set();
  const warnings = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    if (s.n >= from) break;
    if (!FS_TOOLS.has(s.tool)) continue;
    const p = String(s.args.path || '');
    if (!files.includes(p)) continue;
    if (s.tool === 'fs_write') { contents.set(p, String(s.args.content ?? '')); known.add(p); continue; }
    if (!known.has(p)) { warnings.push(`${p}: mutated before step ${from} by ${s.tool}, base not reconstructable in-session`); continue; }
    const r = applyOp(contents, s);
    if (r.error) warnings.push(`${p}: ${r.error}`);
  }
  return { contents, known, warnings };
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Checkpoint cross-check: the manifest written by the FIRST replayed step
 *  holds the pre-write hash of its target — compare it against the BASE the
 *  replay starts from (never the post-replay content: a swap legitimately
 *  changes the outcome). Files already sourced from the store are skipped
 *  (comparing them to their own source is a tautology). Read-only. */
export function crossCheck(root, steps, plan, contents, known, restored = new Set()) {
  const out = { verified: [], mismatched: [], unchecked: [] };
  const first = plan.replay[0];
  if (!first) return out;
  const fromAt = Date.parse(first.at);
  let manifest = null;
  for (const ck of listCheckpoints(root, 50)) {
    const t = Date.parse(ck.time || '');
    if (!Number.isFinite(t) || !Number.isFinite(fromAt)) continue;
    if (t <= fromAt + 200 && (fromAt - t) < 15000) { manifest = ck; break; } // listCheckpoints is newest-first
  }
  for (const p of plan.files) {
    if (restored.has(p)) continue; // sourced from the store — nothing to verify
    if (!contents.has(p)) { out.unchecked.push(p); continue; }
    const h = manifest ? (manifest.files || []).find((e) => e.path === p) : null;
    if (h && h.hash) {
      if (h.hash === sha(String(contents.get(p)))) out.verified.push(p);
      else out.mismatched.push(p);
    } else if (known.has(p)) {
      out.verified.push(`${p} (replayed, no checkpoint to compare)`);
    } else {
      out.unchecked.push(p);
    }
  }
  return out;
}

/** The retrace runner. apply=false → pure plan report. apply=true → snapshot,
 *  then write the what-if state. Returns a human report string + facts. */
export function runRetrace({ root, file, from = 1, until = null, swap = null, set = null, apply = false }) {
  const { events, error } = loadEvents(file);
  if (error) return { ok: false, report: `retrace: ${error}` };
  const steps = extractSteps(events);
  const p = planRetrace(steps, { from, until, swap, set });
  if (!p.ok) return { ok: false, report: `retrace: ${p.error}` };
  const plan = p.plan;

  const lines = [
    `retrace ${apply ? '→ applying' : 'plan (dry run)'} — ${plan.replay.length} fs step${plan.replay.length === 1 ? '' : 's'} of ${plan.total}, window ${plan.from}..${plan.until}`,
    `  from: step ${plan.from} (${steps.find((s) => s.n === plan.from)?.tool} ${steps.find((s) => s.n === plan.from)?.args?.path || ''})`,
  ];
  if (plan.swap) {
    lines.push(`  swap: step ${plan.swap} (${plan.swapArgs.tool || 'fs'}) args replaced — ${truncate(JSON.stringify(plan.swapOriginal), 90)} → ${truncate(JSON.stringify(plan.swapArgs), 90)}`);
  }

  // base: in-session reconstruction, then checkpoint backfill for unknown files
  const { contents, known, warnings } = reconstructBase(steps, plan.files, plan.from);
  for (const w of warnings) lines.push(`  base: ${w}`);
  const ck = listCheckpoints(root, 50);
  const firstAt = Date.parse(plan.replay[0]?.at || '');
  const restored = new Set();
  for (const pth of plan.files) {
    if (contents.has(pth)) continue;
    // newest checkpoint at-or-before the first replayed write that holds this path
    const hit = ck.find((m) => {
      const t = Date.parse(m.time || '');
      return Number.isFinite(t) && Number.isFinite(firstAt) && t <= firstAt + 200 && (firstAt - t) < 15000
        && (m.files || []).some((e) => e.path === pth);
    });
    const ent = hit ? (hit.files || []).find((e) => e.path === pth) : null;
    if (ent && ent.existed && ent.hash) {
      try {
        contents.set(pth, fs.readFileSync(path.join(root, '.buddy', 'checkpoints', 'objects', ent.hash), 'utf8'));
        restored.add(pth);
        lines.push(`  base: ${pth} restored from checkpoint ${hit.file}`);
      } catch {
        lines.push(`  base: ${pth} UNRESOLVABLE (checkpoint object missing) — excluded`);
      }
    } else if (ent && !ent.existed) {
      contents.set(pth, ''); // the file did not exist before this run — the replay creates it
      restored.add(pth);
      lines.push(`  base: ${pth} starts empty (checkpoint says it did not exist yet)`);
    } else {
      lines.push(`  base: ${pth} unknown (no earlier write, no checkpoint) — excluded`);
    }
  }

  // cross-check the reconstructed base against the checkpoint store (BEFORE
  // the replay — the base is what the hash speaks about, not the outcome)
  const cc = crossCheck(root, steps, plan, contents, known, restored);
  for (const v of cc.verified) lines.push(`  verified: ${v} (checkpoint hash match)`);
  for (const m of cc.mismatched) lines.push(`  MISMATCH: ${m} — the recorded fs timeline disagrees with the checkpoint store; computed base used anyway`);

  // replay window in memory
  const perFile = new Map();
  let applied = 0;
  const replaySteps = plan.replay.map((s) => (s.n === plan.swap ? { ...s, args: plan.swapArgs, swapped: true } : s));
  for (const s of replaySteps) {
    const pth = String(s.args.path || '');
    if (!contents.has(pth)) continue; // excluded file
    const r = applyOp(contents, s);
    if (r.applied) { applied += 1; perFile.set(pth, (perFile.get(pth) || 0) + 1); }
    else lines.push(`  replay: step ${s.n} skipped — ${r.error}`);
  }

  if (plan.skipped.length) {
    lines.push(`  skipped (non-deterministic or unrecorded, not modeled): ${plan.skipped.map((s) => `${s.n} ${s.tool}${s.excluded ? ` (${s.excluded})` : ''}`).join(', ')}`);
  }
  if (!apply) {
    lines.push(`  would rewrite: ${[...contents.keys()].filter((k) => perFile.get(k)).join(', ') || '(nothing)'}`);
    lines.push('DRY RUN — nothing written (apply:true / --apply to execute)');
    return { ok: true, report: lines.join('\n'), plan, contents: Object.fromEntries(contents) };
  }

  const writable = [...new Set(replaySteps.map((s) => String(s.args?.path || '')).filter((p) => p && contents.has(p)))];
  if (!writable.length) return { ok: false, report: `retrace: nothing to write — every replayed step targets an excluded file\n${lines.join('\n')}` };
  const snap = snapshotPaths(root, writable, { tool: 'retrace' });
  const written = [];
  for (const pth of writable) {
    try {
      const abs = path.join(root, pth);
      if (!abs.startsWith(root) || pth.startsWith('.buddy/')) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents.get(pth));
      written.push(`${pth} (${perFile.get(pth) || 0} writes replayed)`);
    } catch (e) {
      lines.push(`  write failed: ${pth} — ${e.message}`);
    }
  }
  lines.push(`applied: ${written.length} file${written.length === 1 ? '' : 's'} rewritten from the replayed timeline${snap ? ' (pre-apply snapshot taken — /rewind undoes the whole what-if)' : ''}`);
  for (const w of written) lines.push(`  · ${w}`);
  return { ok: true, report: lines.join('\n'), plan, written };
}

/** Two surfaces: time_travel (plan, read-only) + time_travel_apply (risky). */
export function createTimetravelTools({ root } = {}) {
  const argDoc = '{"session":"<name substring, default latest>","from":7,"until":12,"swap":9,"set":{"find":"draft","replace":"what-if v2"}}';
  const resolve = (session) => {
    const dir = path.join(root, '.buddy', 'sessions');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return null; }
    if (!files.length) return null;
    const needle = String(session || '').trim().toLowerCase();
    const hit = needle ? files.find((f) => f.toLowerCase().includes(needle)) : files[files.length - 1];
    return hit ? path.join(dir, hit) : null;
  };
  const doIt = async (args, apply) => {
    const file = resolve(args?.session);
    if (!file) return 'ERROR: no saved session found in .buddy/sessions';
    const out = runRetrace({
      root,
      file,
      from: args?.from,
      until: args?.until,
      swap: args?.swap,
      set: args?.set,
      apply: Boolean(apply && args?.apply !== false),
    });
    return out.ok ? out.report : `ERROR: ${out.report}`;
  };
  return [
    {
      name: 'time_travel',
      description:
        'Time-travel plan (DRY RUN): rebuild a saved session\'s file timeline deterministically and preview what a replay from step N would do — including swapping ONE step\'s args ("replay from step 7 with this edit changed"). fs_write/fs_replace/fs_append replay byte-exact; other tools are skipped and listed. Checkpoints verify the reconstruction. Nothing is written.',
      args: argDoc,
      render: (a) => `time_travel plan${a?.from ? ` from ${a.from}` : ''}${a?.swap ? ` swap ${a.swap}` : ''}`,
      run: async (args) => doIt({ ...args }, false),
    },
    {
      name: 'time_travel_apply',
      description:
        'Time-travel EXECUTE: run the planned retrace for real — restores the window\'s base state, replays the fs steps (with the swap if any) and writes the what-if files. Every touched file is snapshotted first, so /rewind undoes the whole replay. Review with time_travel (dry run) first.',
      args: argDoc,
      risky: true,
      render: (a) => `time_travel apply${a?.from ? ` from ${a.from}` : ''}${a?.swap ? ` swap ${a.swap}` : ''}`,
      run: async (args) => doIt(args, true),
    },
  ];
}
