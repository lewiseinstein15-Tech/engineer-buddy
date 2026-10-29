// goals.js — goals & scheduled runs (v0.47.0, §11). CORE module — the CLI
// layer lives in index.js (cmdGoals); this file is the whole engine.
//
// RECONCILIATION NOTE (two-writer protocol, third contact, 2026-10-29): this
// plane was rebuilt THREE times in one morning — two sessions wrote it in
// parallel and clobbered each other mid-flight (the file on disk before this
// rebuild was a stale flat-store variant whose own header claimed it was
// "restored to the tested contract"; its test could not even import it).
// The contract that survives is the one TWO independent artifacts agree on:
// test/v047.test.js (the executable spec) and index.js cmdGoals (the CLI).
// This file implements THAT contract, and nothing else:
//   - a .buddy/goals/ tree: goals.json + history.jsonl + run.lock + runs/;
//   - three schedule forms — --every <minutes> | --cron "m h dom mon dow"
//     (UTC, zero-dep engine) | --at "YYYY-MM-DD HH:MM" (one-shot);
//   - HELD junk entries (never scheduled, never silently dropped), degrading
//     VIEWS (loadGoals → {goals, problems[]}) vs strict MUTATIONS (throw);
//   - an O_EXCL tick lock with loud stale-steal — two overlapping wakes can
//     never double-fire;
//   - per-run artifacts (.buddy/goals/runs/<id>-<ts>/result.json +
//     stream.jsonl) that NEVER persist the prompt text — promptChars only;
//   - a lazy brain probe: a tick with nothing due never probes; an
//     unreachable brain is an honest SKIP that still lands in history;
//   - a runner cannot fabricate a pass: status comes from a whitelist, a
//     lying status is coerced to error, a thrown runner is an honest error
//     row and one bad goal never kills the batch.
//
// A goal is a long-running objective that wakes on a schedule: the operator
// registers a prompt + a schedule, and `buddy goals run` fires every due goal
// through the REAL headless agent loop (a fresh child per run — a crashed
// goal can never take the tick down). Buddy does not daemonize: the wake is
// external (OS cron, GitHub Actions cron) and Buddy is honest about that —
// `goals run` is a tick, not a daemon.
//
// House rules this file lives by:
//   - definitions are DATA — a goal is never executed as code, only ever used
//     as the task text of a normal (gated, why-carrying) agent run;
//   - ids are machine-generated and never user-supplied; name/prompt are
//     display/task text only and are NEVER used to build paths;
//   - junk in → honest refusal (mutations throw) or honest degradation
//     (views report problems[]), never a guess.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GOALS_DIR = '.buddy/goals';
export const MAX_GOALS = 200;            // a junk flood cannot grow the store forever
export const MAX_MAX_MINUTES = 525600;   // --every cap: one year, in minutes
export const RUN_MINUTES_CAP = 720;      // --max-minutes cap: 12h per run
export const DEFAULT_MAX_MINUTES = 10;   // a goal without --max-minutes gets this as its child timeout
export const FAST_TIMEOUT_MS = 120000;   // --fast caps the child timeout outright
export const STALE_LOCK_MS = 60 * 60 * 1000; // a tick older than this was killed — steal it
export const MAX_NAME = 120;
export const MAX_PROMPT = 8000;
const STATUS_WHITELIST = ['ok', 'no_reply', 'error', 'timeout'];

export function storePath(root) { return path.join(String(root ?? ''), GOALS_DIR, 'goals.json'); }
export function historyPath(root) { return path.join(String(root ?? ''), GOALS_DIR, 'history.jsonl'); }
export function lockPath(root) { return path.join(String(root ?? ''), GOALS_DIR, 'run.lock'); }
export function runsDir(root) { return path.join(String(root ?? ''), GOALS_DIR, 'runs'); }

// ── small helpers ────────────────────────────────────────────────────────────

const isoOrNull = (v) => {
  const t = v == null ? NaN : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const rndId = () => 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

/** Hard length cap — a pure slice, no ellipsis: callers depend on the exact
 *  bound (rendered rows must stay one line and bounded). */
const cap = (s, n) => {
  const str = String(s ?? '');
  return str.length <= n ? str : str.slice(0, n);
};

/** oneLine — display text: strip ANSI escapes + OSC sequences + control
 *  chars, collapse whitespace, cap length. A hostile name cannot smuggle
 *  terminal escape codes into listings or break the one-line-per-row
 *  contract. */
export function oneLine(s, n = 60) {
  return cap(
    String(s ?? '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    Math.max(1, Number(n) || 60)
  );
}

// ── the cron engine (UTC, zero-dep) ──────────────────────────────────────────

const CRON_FIELDS = [
  ['min', 0, 59],
  ['hour', 0, 23],
  ['dom', 1, 31],
  ['mon', 1, 12],
  ['dow', 0, 7],
];

/** parseCron("min hour dom mon dow") → {min,hour,dom,mon,dow} sorted unique
 *  arrays (dow 7 normalizes to Sunday=0). Refuses, never guesses: wrong field
 *  count, junk atoms, reversed ranges, zero steps, out-of-range values. */
export function parseCron(expr) {
  const s = String(expr ?? '').trim();
  const fields = s.split(/\s+/);
  if (fields.length !== 5 || fields.some((f) => f === '')) {
    throw new Error(`invalid --cron expression "${oneLine(s, 40)}" — expected exactly 5 fields: "min hour dom mon dow" (UTC)`);
  }
  const out = {};
  for (const [i, [key, lo, hi]] of CRON_FIELDS.entries()) {
    const set = new Set();
    for (const atom of fields[i].split(',')) {
      const m = /^(\*|[0-9]+)(?:-([0-9]+))?(?:\/([0-9]+))?$/.exec(atom);
      if (!m) throw new Error(`invalid --cron atom "${oneLine(atom, 16)}" in "${oneLine(s, 40)}" — atoms are *, N, A-B, with an optional /step`);
      let a = lo, b = hi, step = 1;
      if (m[1] === '*') {
        if (m[2] != null) throw new Error(`invalid --cron atom "${atom}" — "*" cannot take a range`);
      } else {
        a = Number(m[1]);
        b = m[2] != null ? Number(m[2]) : a;
      }
      if (m[3] != null) {
        step = Number(m[3]);
        if (step < 1) throw new Error(`invalid --cron step "/${m[3]}" in "${oneLine(s, 40)}" — steps start at 1`);
      }
      if (m[2] != null && b < a) throw new Error(`invalid --cron range "${atom}" in "${oneLine(s, 40)}" — reversed ranges never match`);
      if (a < lo || b > hi) throw new Error(`invalid --cron value in "${atom}" — ${key} must be ${lo}..${hi}`);
      for (let v = a; v <= b; v += step) set.add(v);
    }
    if (key === 'dow' && set.has(7)) { set.delete(7); set.add(0); } // 7 == Sunday
    out[key] = [...set].sort((x, y) => x - y);
  }
  return out;
}

/** Next fire strictly AFTER nowMs (epoch ms), UTC math. Standard cron
 *  dom/dow rule: when BOTH are restricted, either may fire. A pattern that
 *  matches no minute within a one-year window (next Feb 29 from a non-leap
 *  stretch) is REFUSED with an error — never guessed, never drifted. */
export function nextCronFire(expr, nowMs = Date.now()) {
  const p = parseCron(expr);
  const t = Number(nowMs);
  if (!Number.isFinite(t)) throw new Error('nextCronFire: nowMs must be a finite epoch-ms number');
  const domAll = p.dom.length === 31;
  const dowAll = p.dow.length === 7;
  const start = Math.floor(t / 60000) * 60000 + 60000; // strictly after t, minute-aligned
  const end = start + 366 * 24 * 60 * 60000;           // the one-year honesty window
  for (let c = start; c < end; c += 60000) {
    const d = new Date(c);
    if (!p.mon.includes(d.getUTCMonth() + 1)) continue;
    if (!p.min.includes(d.getUTCMinutes()) || !p.hour.includes(d.getUTCHours())) continue;
    const domOk = p.dom.includes(d.getUTCDate());
    const dowOk = p.dow.includes(d.getUTCDay());
    if (!domAll && !dowAll ? !(domOk || dowOk) : !(domOk && dowOk)) continue;
    return c;
  }
  throw new Error(`--cron "${oneLine(String(expr), 40)}" never fires within the one-year window — refused, not guessed`);
}

/** --at parser: "YYYY-MM-DD HH:MM" (UTC) or a full ISO timestamp → ISO string.
 *  Impossible dates are refused, never coerced. */
export function parseAt(v) {
  const raw = String(v ?? '').trim();
  if (!raw) throw new Error('--at is required for the one-shot form — e.g. --at "2026-11-01 09:30" (UTC)');
  const s = raw.replace(' ', 'T'); // first space → T: "2026-11-01 09:30" becomes ISO-ish
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) {
    // a date with NO time part ("2026-01-01"), prose ("tomorrow"), or a torn
    // form never reaches Date.parse — date-only strings parse as UTC midnight
    // and that is a GUESS about intent, not a schedule. RED TEAM v0.49 found
    // exactly this leak: at=2026-01-01 slipped through as midnight.
    throw new Error(`--at must be "YYYY-MM-DD HH:MM" (UTC) or a full ISO timestamp with the time part — got "${oneLine(raw, 40)}", which is not a real moment`);
  }
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7] ?? 'Z'}`;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    throw new Error(`--at must be "YYYY-MM-DD HH:MM" (UTC) or a full ISO timestamp — got "${oneLine(raw, 40)}", which is not a real moment`);
  }
  return new Date(t).toISOString();
}

// ── buildGoal / normalizeGoal: refuse, never guess ──────────────────────────

/** scheduleText — the one-line schedule + state renderer. Junk-tolerant by
 *  construction: null → '(junk goal)', no schedule → UNSCHEDULABLE, and the
 *  honest state suffixes (disabled / maxed / HELD) ride along. */
export function scheduleText(g) {
  if (!g || typeof g !== 'object') return '(junk goal)';
  const s = g.schedule ?? null;
  let base;
  if (s && s.kind === 'every' && Number.isInteger(s.minutes)) base = `every ${s.minutes}m`;
  else if (s && s.kind === 'cron' && typeof s.expr === 'string') base = `cron ${s.expr} (UTC)`;
  else if (s && s.kind === 'at' && typeof s.at === 'string') base = `at ${s.at}`;
  else base = 'UNSCHEDULABLE (no valid schedule)';
  const suffix = [];
  if (g.enabled === false) suffix.push('disabled');
  if (g.maxRuns != null && Number.isInteger(g.maxRuns) && (g.runCount ?? 0) >= g.maxRuns) {
    suffix.push(`maxed (${g.runCount ?? 0}/${g.maxRuns} runs)`);
  }
  if (g.hold) suffix.push(`HELD: ${oneLine(g.hold, 60)}`);
  return cap(base + (suffix.length ? ' · ' + suffix.join(' · ') : ''), 200);
}

/** buildGoal — the registration path. Exactly ONE schedule form; defaults
 *  you can trust; every junk input is a thrown refusal with the flag named. */
export function buildGoal({ name, prompt, everyMinutes, cron, at, maxMinutes, yolo } = {}) {
  const n = oneLine(name, MAX_NAME);
  if (!n) throw new Error('a goal needs a name — buddy goals set "<name>" --prompt "…" --every <minutes> (or --cron / --at)');
  const p = typeof prompt === 'string' ? prompt.trim() : '';
  if (!p) throw new Error('a goal needs --prompt "<task text>" — what should Buddy do on each wake?');
  if (p.length > MAX_PROMPT) throw new Error(`--prompt too long (${p.length} > ${MAX_PROMPT} chars)`);
  const forms = [
    everyMinutes != null && everyMinutes !== '',
    cron != null && String(cron).trim() !== '',
    at != null && String(at).trim() !== '',
  ].filter(Boolean).length;
  if (forms === 0) {
    throw new Error('exactly one schedule form is required — --every <minutes> | --cron "<expr>" (UTC) | --at "YYYY-MM-DD HH:MM" (one-shot)');
  }
  if (forms > 1) {
    throw new Error('exactly ONE schedule form — --every, --cron and --at are mutually exclusive (a goal with two calendars is a goal that lies)');
  }
  let schedule, every = null, cronOut = null, atOut = null;
  if (everyMinutes != null && everyMinutes !== '') {
    const num = typeof everyMinutes === 'number' ? everyMinutes : String(everyMinutes).trim() === '' ? NaN : Number(everyMinutes);
    if (!Number.isInteger(num) || num < 1 || num > MAX_MAX_MINUTES) {
      throw new Error(`--every must be a whole number of minutes 1..${MAX_MAX_MINUTES} (got ${oneLine(JSON.stringify(everyMinutes ?? null), 24)})`);
    }
    every = num;
    schedule = { kind: 'every', minutes: num };
  } else if (cron != null && String(cron).trim() !== '') {
    cronOut = String(cron).trim();
    parseCron(cronOut); // throws on junk — the stored expr is always a valid one
    schedule = { kind: 'cron', expr: cronOut };
  } else {
    atOut = parseAt(at);
    schedule = { kind: 'at', at: atOut };
  }
  let mm = null;
  if (maxMinutes != null && maxMinutes !== '') {
    const mnum = typeof maxMinutes === 'number' ? maxMinutes : String(maxMinutes).trim() === '' ? NaN : Number(maxMinutes);
    if (!Number.isInteger(mnum) || mnum < 1 || mnum > RUN_MINUTES_CAP) {
      throw new Error(`--max-minutes must be a whole number 1..${RUN_MINUTES_CAP} (got ${oneLine(JSON.stringify(maxMinutes ?? null), 24)})`);
    }
    mm = mnum;
  }
  return {
    id: rndId(),
    name: n,
    prompt: p,
    schedule,
    everyMinutes: every,
    cron: cronOut,
    at: atOut,
    maxMinutes: mm,
    yolo: yolo === true,
    enabled: true,
    runCount: 0,
    createdAt: new Date().toISOString(),
    lastRun: null,
    lastStatus: null,
  };
}

/** Rebuild a store entry from WHITELISTED fields only — a hostile goals.json
 *  cannot smuggle extra keys (or a __proto__ own-key) into our objects (the
 *  v0.44 lesson, replayed). A junk entry (junk id, junk schedule) still
 *  loads but is HELD: reported by list, never scheduled by run, never
 *  silently dropped. */
export function normalizeGoal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' && /^g-[0-9a-z-]{3,64}$/.test(raw.id) ? raw.id : null;
  const every = Number(raw.everyMinutes);
  const everyPresent = raw.everyMinutes != null && raw.everyMinutes !== '';
  const validEvery = Number.isInteger(every) && every >= 1 && every <= MAX_MAX_MINUTES;
  const cronExpr = typeof raw.cron === 'string' && raw.cron.trim() !== '' ? raw.cron.trim() : null;
  let cronOk = false;
  if (cronExpr != null) { try { parseCron(cronExpr); cronOk = true; } catch { cronOk = false; } }
  const atIso = typeof raw.at === 'string' && raw.at.trim() !== '' ? (() => { try { return parseAt(raw.at); } catch { return null; } })() : null;
  const forms = [everyPresent && validEvery, cronOk, !!atIso].filter(Boolean).length;
  const junkForms = [everyPresent && !validEvery, cronExpr != null && !cronOk, raw.at != null && String(raw.at).trim() !== '' && !atIso].some(Boolean);
  let schedule = null;
  if (forms === 1 && !junkForms) {
    if (everyPresent && validEvery) schedule = { kind: 'every', minutes: every };
    else if (cronOk) schedule = { kind: 'cron', expr: cronExpr };
    else schedule = { kind: 'at', at: atIso };
  }
  const holds = !id || !schedule;
  return {
    id: id ?? 'g-corrupt-' + Math.random().toString(36).slice(2, 8),
    name: oneLine(raw.name, MAX_NAME) || '(unnamed goal)',
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    schedule,
    everyMinutes: schedule?.kind === 'every' ? schedule.minutes : null,
    cron: schedule?.kind === 'cron' ? schedule.expr : null,
    at: schedule?.kind === 'at' ? schedule.at : null,
    maxMinutes: Number.isInteger(raw.maxMinutes) && raw.maxMinutes >= 1 && raw.maxMinutes <= RUN_MINUTES_CAP ? raw.maxMinutes : null,
    yolo: raw.yolo === true,
    enabled: raw.enabled !== false,
    runCount: Number.isInteger(raw.runCount) && raw.runCount >= 0 ? raw.runCount : 0,
    createdAt: isoOrNull(raw.createdAt) ?? new Date().toISOString(),
    lastRun: isoOrNull(raw.lastRun),
    lastStatus: typeof raw.lastStatus === 'string' ? raw.lastStatus : null,
    ...(holds
      ? { hold: 'junk definition — refused to schedule until fixed (buddy goals remove <id>, then set it again)' }
      // a hand-edited hold must SURVIVE the load — RED TEAM v0.49 finding #3:
      // the read-side whitelist used to strip it, so a held goal silently
      // became runnable again the next time the store was read. Any truthy
      // raw hold becomes a bounded string reason; junk types are normalized,
      // never dropped.
      : (raw.hold
        ? { hold: typeof raw.hold === 'string' && raw.hold.trim() ? oneLine(raw.hold, 160) : 'held (store)' }
        : {})),
  };
}

// ── the store: views degrade, mutations refuse ──────────────────────────────

/** loadGoals — the VIEW: a missing store is empty; a torn, foreign-shaped or
 *  flooded store degrades into problems[] (never an exception, nothing ever
 *  auto-deleted). { goals, problems } — always exactly that shape. */
export function loadGoals(root) {
  const file = storePath(root);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { goals: [], problems: [] };
    return { goals: [], problems: [`goals store unreadable — ${oneLine(String(e?.message || e), 160)} (${file}) — nothing was deleted`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { goals: [], problems: [`goals store is corrupt (torn JSON) — fix or remove it by hand, nothing was deleted: ${file}`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.goals)) {
    return { goals: [], problems: [`goals store has the wrong shape (expected {"goals":[…]}) — fix or remove it by hand, nothing was deleted: ${file}`] };
  }
  const problems = [];
  if (parsed.goals.length > MAX_GOALS) {
    problems.push(`goals store holds ${parsed.goals.length} goals (cap ${MAX_GOALS}) — a junk flood cannot grow it forever; remove some by hand if this is real: ${file}`);
  }
  const goals = parsed.goals.map((g) => normalizeGoal(g)).filter(Boolean);
  for (const g of goals) if (g.hold) problems.push(`HELD ${g.id} ${g.name} — ${g.hold}`);
  return { goals, problems };
}

/** loadStrict — the MUTATION path: the same refusals, but thrown. A tick or
 *  a registration never operates on a store it cannot honestly read. */
function loadStrict(root) {
  const file = storePath(root);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { goals: [], problems: [] };
    throw new Error(`goals store unreadable — ${oneLine(String(e?.message || e), 160)} (${file})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`goals store is corrupt (torn JSON) — fix or remove it by hand, nothing was deleted: ${file}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.goals)) {
    throw new Error(`goals store has the wrong shape (expected {"goals":[…]}) — fix or remove it by hand, nothing was deleted: ${file}`);
  }
  if (parsed.goals.length > MAX_GOALS) {
    throw new Error(`goals store holds ${parsed.goals.length} goals (cap ${MAX_GOALS}) — refusing to mutate a flooded store: ${file}`);
  }
  const problems = [];
  const goals = parsed.goals.map((g) => normalizeGoal(g)).filter(Boolean);
  for (const g of goals) if (g.hold) problems.push(`HELD ${g.id} ${g.name} — ${g.hold}`);
  return { goals, problems };
}

function saveGoals(root, goals) {
  const file = storePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // whitelisted fields only — the store we write is exactly the store we would read back
  const body = JSON.stringify({
    goals: goals.map((g) => ({
      id: g.id,
      name: g.name,
      prompt: g.prompt,
      schedule: g.schedule ?? null,
      everyMinutes: g.everyMinutes ?? null,
      cron: g.cron ?? null,
      at: g.at ?? null,
      maxMinutes: g.maxMinutes ?? null,
      yolo: g.yolo === true,
      enabled: g.enabled !== false,
      runCount: g.runCount ?? 0,
      createdAt: g.createdAt,
      lastRun: g.lastRun ?? null,
      lastStatus: g.lastStatus ?? null,
      ...(g.hold ? { hold: g.hold } : {}),
    })),
  }, null, 2) + '\n';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}

/** Resolve a goal by id-prefix first, then by (unambiguous) name — the
 *  operator types `goals disable CLI`, not a full snowflake id. Ambiguity is
 *  REFUSED with the candidates; nothing is ever guessed. THROWS (mutations
 *  refuse — callers and tests get the throw, not a promise of one). */
function findGoal(goals, prefix) {
  const p = String(prefix ?? '').trim();
  if (!p) throw new Error('a goal id (or an unambiguous name/prefix) is required — buddy goals list shows the ids');
  const list = Array.isArray(goals) ? goals : [];
  const byId = list.filter((g) => g.id.startsWith(p));
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) throw new Error(`"${oneLine(p, 24)}" matches ${byId.length} goals — be more specific: ${byId.map((h) => h.id).join(', ')}`);
  const byName = list.filter((g) => g.name === p || g.name.startsWith(p));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`"${oneLine(p, 24)}" matches ${byName.length} goals by name — be more specific or use the id: ${byName.map((h) => h.id).join(', ')}`);
  throw new Error(`no goal matches "${oneLine(p, 24)}" — buddy goals list shows the ids`);
}

export function addGoal(root, input) {
  const goal = buildGoal(input); // throws on junk — registration refuses, never guesses
  const { goals, problems } = loadStrict(root);
  if (goals.length >= MAX_GOALS) throw new Error(`goal cap reached (${MAX_GOALS}) — remove one first (buddy goals list)`);
  saveGoals(root, [...goals, goal]);
  return { goal, problems };
}

export function removeGoal(root, prefix) {
  const { goals, problems } = loadStrict(root);
  const g = findGoal(goals, prefix);
  saveGoals(root, goals.filter((x) => x.id !== g.id));
  return { goal: g, problems };
}

export function setGoalEnabled(root, prefix, enabled) {
  const { goals, problems } = loadStrict(root);
  const g = findGoal(goals, prefix);
  saveGoals(root, goals.map((x) => (x.id === g.id ? { ...x, enabled: enabled === true } : x)));
  return { goal: { ...g, enabled: enabled === true }, problems };
}

function recordRun(root, id, { at, status }) {
  const { goals } = loadStrict(root);
  saveGoals(
    root,
    goals.map((g) => (g.id === id ? { ...g, lastRun: at, lastStatus: String(status), runCount: (g.runCount ?? 0) + 1 } : g))
  );
}

// ── scheduling (pure — inject `now` in tests) ───────────────────────────────

/** Next wake as a Date, or null when this goal can never fire: disabled,
 *  maxed out, HELD, unparsable stamps, or a phantom cron (honest null — the
 *  registration already refused phantoms, a hand-edited store gets held).
 *  every: lastRun(+createdAt) + minutes — may be in the PAST (overdue).
 *  cron: the next slot strictly after lastRun ?? now — cron never backfills.
 *  at: the one moment itself, and only before it has fired once. Clock skew
 *  is handled by the math — a lastRun in the future is simply not due until
 *  the clock passes it. */
export function nextDue(goal, nowMs = Date.now()) {
  if (!goal || typeof goal !== 'object' || goal.enabled === false || goal.hold) return null;
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return null;
  if (goal.maxRuns != null && (goal.runCount ?? 0) >= goal.maxRuns) return null;
  const s = goal.schedule ?? null;
  if (!s) return null;
  if (s.kind === 'every') {
    const every = Number(s.minutes);
    if (!Number.isInteger(every) || every < 1) return null;
    const base = Date.parse(goal.lastRun ?? goal.createdAt);
    if (!Number.isFinite(base)) return null;
    return new Date(base + every * 60000);
  }
  if (s.kind === 'cron') {
    try {
      return new Date(nextCronFire(s.expr, goal.lastRun != null ? Date.parse(goal.lastRun) : now));
    } catch {
      return null; // phantom pattern — never fires, honestly null
    }
  }
  if (s.kind === 'at') {
    if ((goal.runCount ?? 0) >= 1) return null; // a one-shot that fired never re-fires
    const t = Date.parse(s.at);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  return null;
}

/** The tick's firing decision — DIFFERENT from nextDue for cron by design:
 *  a cron goal is due when a matching slot has ARRIVED since it was last
 *  handled (or registered). nextDue shows the NEXT future slot; the tick
 *  must not wait for the slot after it to be due. most-overdue first. */
function dueList(goals, now) {
  const rows = [];
  for (const g of Array.isArray(goals) ? goals : []) {
    if (!g || g.enabled === false || g.hold) continue;
    if (g.maxRuns != null && (g.runCount ?? 0) >= g.maxRuns) continue;
    const s = g.schedule ?? null;
    if (!s) continue;
    if (s.kind === 'every') {
      const every = Number(s.minutes);
      const base = Date.parse(g.lastRun ?? g.createdAt);
      if (Number.isInteger(every) && every >= 1 && Number.isFinite(base)) {
        const due = base + every * 60000;
        if (due <= now) rows.push({ g, due });
      }
    } else if (s.kind === 'cron') {
      const base = g.lastRun != null ? Date.parse(g.lastRun) : Date.parse(g.createdAt);
      if (!Number.isFinite(base)) continue;
      try {
        const slot = nextCronFire(s.expr, base); // first slot strictly after the last handled moment
        if (slot <= now) rows.push({ g, due: slot });
      } catch { /* phantom — stays registered, stays idle */ }
    } else if (s.kind === 'at') {
      if ((g.runCount ?? 0) >= 1) continue;
      const t = Date.parse(s.at);
      if (Number.isFinite(t) && t <= now) rows.push({ g, due: t });
    }
  }
  return rows.sort((a, b) => a.due - b.due).map((r) => r.g);
}

export function nextWake(goals, nowMs = Date.now()) {
  const ds = (Array.isArray(goals) ? goals : [])
    .map((g) => nextDue(g, nowMs))
    .filter((d) => d != null)
    .map((d) => d.getTime());
  return ds.length ? Math.min(...ds) : null;
}

// ── history (append-only JSONL; torn lines are skipped, never fatal) ────────

export function appendHistory(root, row) {
  try {
    const file = historyPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `history append failed — ${cap(String(e?.message || e), 160)}` };
  }
}

export function readHistory(root, { id = null, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 50, 1000));
  let raw;
  try {
    raw = fs.readFileSync(historyPath(root), 'utf8');
  } catch {
    return []; // no history yet — an empty answer, not an error
  }
  const rows = [];
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j === 'object' && (!id || j.id === id)) rows.push(j);
    } catch { /* torn line — history stays readable */ }
  }
  return rows.slice(-lim);
}

// ── the tick lock (two overlapping wakes must never double-fire) ────────────

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true; // signal 0 = existence probe
  } catch (e) {
    return e && e.code === 'EPERM'; // EPERM means it exists but is not ours
  }
}

function writeExclusive(file, data) {
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

export function acquireRunLock(root, { nowMs = Date.now(), staleMs = STALE_LOCK_MS } = {}) {
  const file = lockPath(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch { /* exists */ }
  const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date(nowMs).toISOString() });
  try {
    writeExclusive(file, mine);
    return { ok: true, file };
  } catch (e) {
    if (!e || e.code !== 'EEXIST') return { ok: false, error: `lock create failed — ${cap(String(e?.message || e), 160)}` };
  }
  // EEXIST — whose lock is it, and is it dead?
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    holder = null;
  }
  const heldAt = holder && holder.at ? Date.parse(holder.at) : NaN;
  const age = Number.isFinite(heldAt) ? nowMs - heldAt : NaN;
  if (Number.isFinite(age) && age <= staleMs && holder && pidAlive(holder.pid)) {
    return {
      ok: false,
      busy: true,
      error: `another goal run holds the lock (pid ${holder.pid}, ${Math.round(age / 1000)}s old) — refusing to double-fire`,
    };
  }
  // stale (older than STALE_LOCK_MS), DEAD holder, or junk — steal it, loudly.
  // The dead lock is REMOVED before re-acquiring: writeExclusive is O_EXCL and
  // cannot overwrite, so a steal that skips the unlink can never succeed (the
  // stale file would sit there forever and every later tick would either
  // busy-refuse on a corpse or fail its steal — found by the orphaned wave's
  // own tests). After re-acquiring, the lock is READ BACK to prove WE own it:
  // a ticker that stole in the same window wins, and this tick says so instead
  // of double-firing.
  try {
    fs.unlinkSync(file);
    writeExclusive(file, mine);
    let nowHolder = null;
    try { nowHolder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { nowHolder = null; }
    if (!nowHolder || nowHolder.pid !== process.pid) {
      return { ok: false, busy: true, error: 'lock steal lost the race — another tick holds the lock now' };
    }
    return {
      ok: true,
      file,
      stole: true,
      stoleFrom: holder && holder.pid != null
        ? Number.isFinite(age) && age <= staleMs
          ? `the lock of pid ${holder.pid} — the holder process is gone (${Math.round(age / 1000)}s old)`
          : `the lock of pid ${holder.pid}, ${Number.isFinite(age) ? `${Math.round(age / 1000)}s old` : 'unknown age'}`
        : 'a junk lock',
    };
  } catch (e2) {
    return { ok: false, busy: true, error: `lock steal failed (${cap(String(e2?.message || e2), 160)}) — another tick got there first` };
  }
}

export function releaseRunLock(root, { pid = process.pid } = {}) {
  const file = lockPath(root);
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    holder = null;
  }
  // Only ever remove OUR OWN lock — a live holder's lock is left alone.
  if (holder && holder.pid != null && holder.pid !== pid) {
    return { ok: false, error: `lock is held by pid ${holder.pid} — left it alone` };
  }
  try {
    fs.unlinkSync(file);
    return { ok: true };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true };
    return { ok: false, error: `lock release failed — ${cap(String(e?.message || e), 160)}` };
  }
}

// ── the tick: fire every due goal through the REAL headless agent loop ──────

/** Read the child's stream-json transcript honestly: status comes from the
 *  child's exit + its own result line, never from a wish. Junk events are
 *  tolerated; a SIGKILLed child is a timeout, not a mystery; a fabricated
 *  pass status cannot survive the whitelist. */
export function summarizeChildRun(r) {
  const events = Array.isArray(r?.events) ? r.events : [];
  const result = events.find((e) => e && e.type === 'result');
  const okChild = r && r.code === 0 && r.signal == null;
  const said = result && typeof result.said === 'string' && result.said.trim() ? result.said : null;
  let status;
  if (!okChild) status = r && r.signal ? 'timeout' : 'error';
  else if (result && result.status === 'ok' && said) status = 'ok';
  else if (result && result.status === 'ok') status = 'no_reply';
  else status = 'error';
  const errTail = String((r && r.err) || '').trim().split('\n').filter(Boolean).pop() || 'child failed';
  return {
    status,
    code: r && r.code != null ? r.code : null,
    signal: r && r.signal ? r.signal : null,
    durationMs: null, // filled by the tick with its own wall clock
    steps: result && Number.isInteger(result.steps) ? result.steps : null,
    said: said ? cap(oneLine(said), 200) : null,
    ...(status === 'error' ? { error: cap(errTail, 200) } : {}),
  };
}

/** Default per-goal runner: a FRESH child (`buddy -p <prompt>`) per wake —
 *  process isolation means a crashed goal can never take the tick down. */
export function runPromptDefault({ goal, root, timeoutMs = 600000 } = {}) {
  return import('./benchmark.js')
    .then(({ runOneShot }) => runOneShot(['-p', goal.prompt, '--dir', String(root)], { cwd: String(root), timeoutMs }))
    .then((r) => summarizeChildRun(r))
    .catch((e) => ({
      status: 'error',
      code: null,
      signal: null,
      steps: null,
      said: null,
      error: cap(String(e?.message || e), 200),
    }));
}

/** One tick. NON-async on purpose: everything that must REFUSE (junk args,
 *  a corrupt store, an ambiguous force target, a busy lock) refuses
 *  SYNCHRONOUSLY — operators and tests get the throw, not a promise of one.
 *  Only the probe + run loop await. Fires every due goal (or an explicit
 *  --all / named force), records each run in the store AND the history AND
 *  per-run artifacts, holds the lock for the whole batch, and never lets one
 *  bad goal kill the batch. opts.probe / opts.runPrompt / opts.now are test
 *  seams — the same pattern as benchmark's opts.runners. */
export async function runDueGoals(rootOrOpts, maybeOpts = {}) {
  // ASYNC CONTRACT: runDueGoals always returns a promise and every failure is
  // a rejection — validation (junk root, corrupt store, ambiguous force) and
  // run-time errors share one channel, so `await runDueGoals(...)` in a
  // try/catch and `assert.rejects` both see the same behavior. (The pre-async
  // form threw synchronously before the async body — two error channels for
  // one function is a caller trap.)
  const opts = rootOrOpts !== null && typeof rootOrOpts === 'object' && !Array.isArray(rootOrOpts)
    ? rootOrOpts
    : maybeOpts;
  const root = typeof rootOrOpts === 'string' ? rootOrOpts : opts.root;
  if (typeof root !== 'string' || !root) throw new Error('runDueGoals needs a root directory (a string path)');
  const { goals, problems } = loadStrict(root); // a tick refuses a store it cannot honestly read
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();

  let selected;
  let forceNote = null;
  if (opts.force != null && opts.force !== false) {
    if (opts.force === true) {
      selected = goals.filter((g) => g.enabled !== false && !g.hold);
      forceNote = '--all force: every enabled, non-held goal runs regardless of schedule (operator intent — recorded)';
    } else {
      const g = findGoal(goals, opts.force); // throws on junk/ambiguous — explicit operator intent
      if (g.hold) {
        // THE HOLD CONTRACT: hold means NEVER scheduled by run — not by the
        // tick, not by --all (filtered above), and not even by naming this
        // goal. RED TEAM v0.49: a named force used to pierce the hold.
        throw new Error(`goal ${g.id} (${oneLine(g.name, 40)}) is HELD — hold means it is never scheduled by run, even by an explicit name; clear the hold in the store first if you truly mean it`);
      }
      selected = [g];
      forceNote = `forced: ${g.id} (${oneLine(g.name, 40)}) runs now regardless of schedule or enabled flag (operator intent — recorded)`;
    }
  } else {
    selected = dueList(goals, now);
  }
  const allProblems = [...problems];
  if (forceNote) allProblems.push(forceNote);

  if (!selected.length) {
    const nw = nextWake(goals, now);
    allProblems.push(nw != null
      ? `nothing due — the tick is honestly idle (next wake: ${new Date(nw).toISOString()})`
      : 'nothing due — and no enabled goal will ever wake');
    return Promise.resolve({ passed: 0, failed: 0, skipped: 0, results: [], problems: allProblems, nextWake: nw });
  }

  const lock = acquireRunLock(root, { nowMs: now });
  if (!lock.ok) {
    allProblems.push(lock.error); // names the pid and the double-fire refusal — LAST problem
    return Promise.resolve({ passed: 0, failed: 0, skipped: 0, results: [], problems: allProblems, busy: true });
  }
  if (lock.stole) allProblems.push(`stole ${lock.stoleFrom} — the previous tick died holding it; this tick proceeds`);

  const runPrompt = typeof opts.runPrompt === 'function' ? opts.runPrompt : runPromptDefault;

  return (async () => {
    // the brain probe is LAZY: a tick with nothing to run never probes, and
    // an unreachable brain is an honest SKIP per selected goal — never a
    // fake pass, never a crash, and the SKIPs still land in history.
    let probe = opts.probe;
    if (probe == null) {
      try {
        probe = await import('./benchmark.js').then((m) => m.probeBrainDefault());
      } catch (e) {
        probe = { ok: false, reason: `brain probe failed: ${cap(String(e?.message || e), 160)}` };
      }
    }

    const results = [];
    try {
      for (const goal of selected) {
        const t0 = Date.now();
        if (!probe.ok) {
          const row = {
            at: new Date().toISOString(),
            id: goal.id,
            name: goal.name,
            status: 'SKIP',
            reason: `brain unreachable — ${probe.reason || 'the probe failed'}`,
            durationMs: 0,
            steps: null,
            said: null,
          };
          const hist = appendHistory(root, row);
          if (!hist.ok) row.historyError = hist.error;
          results.push(row);
          continue; // a SKIP does not advance runCount — the schedule owes nothing
        }
        const timeoutMs = opts.fast === true
          ? FAST_TIMEOUT_MS
          : Number.isFinite(Number(opts.timeoutMs)) && goal.maxMinutes == null
            ? Number(opts.timeoutMs)
            : (goal.maxMinutes ?? DEFAULT_MAX_MINUTES) * 60000;
        let r;
        try {
          r = await runPrompt({ goal, g: goal, root, timeoutMs });
        } catch (e) {
          r = { status: 'error', code: null, signal: null, steps: null, said: null, error: String(e?.message || e) };
        }
        const status = STATUS_WHITELIST.includes(r?.status) ? r.status : 'error'; // a fabricated pass cannot survive
        const row = {
          at: new Date().toISOString(),
          id: goal.id,
          name: goal.name,
          status,
          code: r && r.code != null ? r.code : null,
          signal: r && r.signal ? r.signal : null,
          durationMs: Date.now() - t0,
          steps: r && Number.isInteger(r.steps) ? r.steps : null,
          said: r && typeof r.said === 'string' && r.said ? oneLine(r.said, 200) : null,
          ...(status === 'error' ? { error: cap(String((r && r.error) || 'the goal run failed'), 200) } : {}),
        };
        // per-run artifacts — the audit trail: what ran, what it said, what
        // the child streamed. The prompt TEXT is never persisted — the row
        // records promptChars, nothing more (promptChars discipline).
        try {
          const dir = path.join(runsDir(root), `${goal.id}-${t0.toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
            at: row.at,
            id: row.id,
            name: row.name,
            status: row.status,
            code: row.code,
            signal: row.signal,
            durationMs: row.durationMs,
            steps: row.steps,
            said: row.said,
            ...(row.error ? { error: row.error } : {}),
            goal: {
              id: goal.id,
              nameChars: goal.name.length,
              promptChars: goal.prompt.length,
              maxMinutes: goal.maxMinutes ?? DEFAULT_MAX_MINUTES,
              yolo: goal.yolo === true,
              timeoutMs,
            },
          }, null, 2) + '\n', 'utf8');
          const streamText = r && typeof r.out === 'string'
            ? r.out
            : r && Array.isArray(r.events)
              ? r.events.map((e) => { try { return JSON.stringify(e); } catch { return ''; } }).filter(Boolean).join('\n') + '\n'
              : '';
          fs.writeFileSync(path.join(dir, 'stream.jsonl'), streamText, 'utf8');
          row.artifacts = path.relative(root, dir);
        } catch (e) {
          row.artifactsError = cap(String(e?.message || e), 160); // the run happened — say the bookkeeping failed
        }
        try {
          recordRun(root, goal.id, { at: row.at, status }); // real runs advance the store — even failures (honest lastStatus)
        } catch (e) {
          row.recordError = cap(String(e?.message || e), 160);
        }
        const hist = appendHistory(root, row);
        if (!hist.ok) row.historyError = hist.error;
        results.push(row);
      }
    } finally {
      releaseRunLock(root); // best effort — a failed release is the next tick's steal story
    }

    const after = loadGoals(root);
    return {
      passed: results.filter((r) => r.status === 'ok').length,
      failed: results.filter((r) => r.status === 'error' || r.status === 'timeout' || r.status === 'no_reply').length,
      skipped: results.filter((r) => r.status === 'SKIP').length,
      results,
      problems: allProblems,
      nextWake: nextWake(after.goals, Date.now()),
    };
  })();
}

// ── renderers: junk-tolerant by construction ────────────────────────────────

/** The goals table: one bounded, ANSI-free line per goal + '! ' problem
 *  lines. An empty registry explains itself and points at the wake model. */
export function goalsTableText(goals, problems = []) {
  const lines = [];
  const list = Array.isArray(goals) ? goals : [];
  if (!list.length) {
    lines.push('no goals registered — register one:');
    lines.push('  buddy goals set "<name>" --prompt "<task text>" --every <minutes>');
    lines.push('  (or --cron "min hour dom mon dow" (UTC) · or --at "YYYY-MM-DD HH:MM" one-shot)');
    lines.push('  the wake is external: OS cron / GitHub Actions cron calls: buddy goals run');
  }
  for (const g of list) {
    const last = g.lastRun
      ? `${String(g.lastRun).replace('T', ' ').slice(0, 16)}Z ${g.lastStatus ?? '?'}`
      : 'never run';
    lines.push(cap(
      `${String(g.id).slice(0, 14).padEnd(14)} ${oneLine(g.name, 26).padEnd(26)} ${oneLine(scheduleText(g), 42).padEnd(42)} ` +
      `runs:${String(g.runCount ?? 0).padEnd(5)} ${g.enabled === false ? '[disabled] ' : ''}${g.yolo ? '[yolo] ' : ''}${oneLine(last, 60)}`,
      400
    ));
  }
  for (const p of Array.isArray(problems) ? problems : []) lines.push(cap(`! ${oneLine(p, 360)}`, 400));
  return lines.join('\n');
}

/** The tick summary: the honest scoreline first, then one bounded line per
 *  run — SKIP rows show their reason, error rows their error, ok rows their
 *  artifacts path. */
export function runSummaryText(out) {
  const o = out && typeof out === 'object' ? out : {};
  const results = Array.isArray(o.results) ? o.results : [];
  const passed = Number.isInteger(o.passed) ? o.passed : results.filter((r) => r?.status === 'ok').length;
  const failed = Number.isInteger(o.failed) ? o.failed : results.filter((r) => ['error', 'timeout', 'no_reply'].includes(r?.status)).length;
  const skipped = Number.isInteger(o.skipped) ? o.skipped : results.filter((r) => r?.status === 'SKIP').length;
  const lines = [`GOALS RUN — ${results.length} selected · ${passed} passed · ${failed} failed · ${skipped} skipped`];
  if (o.busy) lines.push('lock busy — another tick holds it; nothing was run');
  for (const r of results) {
    const bits = [];
    if (Number.isFinite(Number(r?.durationMs))) bits.push(`${(Number(r.durationMs) / 1000).toFixed(1)}s`);
    if (Number.isInteger(r?.steps)) bits.push(`${r.steps} steps`);
    if (typeof r?.said === 'string' && r.said) bits.push(oneLine(r.said, 80));
    if (r?.artifacts) bits.push(`artifacts: ${r.artifacts}`);
    if (r?.error) bits.push(`error: ${oneLine(r.error, 100)}`);
    if (r?.reason) bits.push(oneLine(r.reason, 110));
    lines.push(cap(`  ${String(r?.status ?? '?').padEnd(5)} ${oneLine(r?.name, 28)}${bits.length ? ' — ' + bits.join(' · ') : ''}`, 400));
  }
  if (o.nextWake != null) {
    const d = new Date(o.nextWake);
    if (Number.isFinite(d.getTime())) lines.push(`next wake: ${d.toISOString()}`);
  }
  return lines.join('\n');
}
