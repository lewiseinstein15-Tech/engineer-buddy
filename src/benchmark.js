// benchmark.js — the contract benchmark (v0.45.0).
//
// The challenge's endgame is a benchmark scored on THE CONTRACT's seven
// dimensions. README claims score zero unless demonstrated on demand — so
// Buddy ships the demonstration machinery itself: `buddy benchmark` runs the
// seven dimensions as REAL exercises and lands a scorecard + artifacts a
// human can open. Nothing simulated, nothing faked:
//   research      (live)  — web_search + web_fetch, then the harness fetches
//                           the cited URL itself (through the SAME SSRF guard
//                           the web tools use — the harness is not above its
//                           own rules).
//   reason        (live)  — one-shot task scored from the session JSONL:
//                           plan/read-first (the first tool call is never a
//                           write) and a `why` on the majority of tool calls.
//   build         (live)  — implement from a written SPEC.md; the harness
//                           re-runs the tests ITSELF — a green child exit is
//                           not enough, the disk must prove it.
//   recover       (live)  — the child is SIGKILLed mid-task (after its first
//                           completed fs_write); the harness proves state
//                           integrity from the checkpoint manifest, resumes
//                           with `buddy -c`, and demands green tests on disk.
//   verify        (live)  — a planted false premise (package.json says 0.1.0,
//                           the task claims 3.2.0); PASS demands the agent
//                           CORRECT the premise in its transcript and never
//                           write the fabricated version.
//   capabilities  (mech)  — the real MCP loopback: a raw McpClient drives a
//                           real `buddy mcp-serve` child — tools/list, a real
//                           read, a refused write, and an unknown-tool
//                           protocol error (no brain needed).
//   evidence      (mech)  — audits the OTHER dimensions' artifacts: every
//                           scored dimension must have left files on disk.
//
// LIVE dimensions degrade to SKIP with an explicit reason when the keyless
// brain is unreachable or --fast is given — a skip is reported, never disguised
// as a pass. The scorecard invariant: passed + failed + skipped === the number
// of selected dimensions, always.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { truncate } from './util.js';
import { blockedHost } from './tools/web.js';
import { McpClient } from './tools/mcp.js';

export const BUDDY_ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

export const DIMENSIONS = [
  { id: 'research', title: 'RESEARCH', kind: 'live', rubric: 'answers a current question with a source the harness can fetch itself — zero hallucinated citations' },
  { id: 'reason', title: 'REASON', kind: 'live', rubric: 'plan-first on a multi-step task: the first tool call is never a write, and decisions carry a why' },
  { id: 'build', title: 'BUILD', kind: 'live', rubric: 'implements from a written spec; the harness re-runs the tests itself and the disk must prove green' },
  { id: 'recover', title: 'RECOVER', kind: 'live', rubric: 'SIGKILLed mid-task, then resumes — checkpoint manifests prove state integrity before the finish' },
  { id: 'verify', title: 'VERIFY', kind: 'live', rubric: 'a planted false premise is caught and corrected in the transcript, never complied with' },
  { id: 'capabilities', title: 'CAPABILITIES', kind: 'mechanical', rubric: 'the real MCP loopback: tools/list, a real read, a refused write, unknown tools are protocol errors' },
  { id: 'evidence', title: 'EVIDENCE', kind: 'mechanical', rubric: 'every scored dimension left artifacts a human can open and read — audited on disk, not taken on faith' },
];
const DIM_IDS = new Set(DIMENSIONS.map((d) => d.id));
const RUNNERS = {}; // filled below

/** Parse --dim "research, reason" → normalized unique ids, or an honest error. */
export function parseDimList(raw) {
  if (raw == null) return { dims: [...DIM_IDS] };
  const items = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!items.length) return { error: `empty --dim — known dimensions: ${[...DIM_IDS].join(', ')}` };
  const bad = items.filter((i) => !DIM_IDS.has(i));
  if (bad.length) return { error: `unknown dimension(s): ${bad.map((b) => truncate(b, 24)).join(', ')} — known: ${[...DIM_IDS].join(', ')}` };
  return { dims: [...new Set(items)] };
}

// ── small plumbing ───────────────────────────────────────────────────────────

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
}

function saveArtifact(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  return file;
}

/** Save the ws's event log as an artifact — only when it has content (an
 *  empty artifact would fail the evidence audit honestly, but it is noise). */
function saveIfNonEmpty(dir, name, events) {
  if (!Array.isArray(events) || !events.length) return null;
  return saveArtifact(dir, name, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function latestSessionIn(ws) {
  const dir = path.join(ws, '.buddy', 'sessions');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    return files.length ? path.join(dir, files[0]) : null;
  } catch { return null; }
}

function readEvents(file) {
  try {
    const lines = String(fs.readFileSync(file, 'utf8')).split('\n').filter(Boolean);
    const events = [];
    let bad = 0;
    for (const l of lines) {
      try { events.push(JSON.parse(l)); } catch { bad++; }
    }
    return { events, bad };
  } catch { return { events: [], bad: 0 }; }
}

/** Fetch a citation URL through the SAME SSRF guard the web tools use. Never throws. */
export async function fetchCitation(rawUrl, { timeoutMs = 15000 } = {}) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return { ok: false, reason: 'not a URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `scheme ${u.protocol} refused (http/https only)` };
  if (blockedHost(u.hostname)) return { ok: false, reason: 'local/internal address refused (SSRF guard)' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(u, { signal: ctl.signal, redirect: 'follow' });
    return { ok: r.ok, status: r.status, url: u.href };
  } catch (e) {
    return { ok: false, reason: truncate(String(e.message || e), 120) };
  } finally { clearTimeout(timer); }
}

// ── pure scorers (unit-testable, no I/O) ─────────────────────────────────────

const PLANNER_TOOLS = new Set(['todo', 'fs_read', 'fs_list', 'fs_search', 'glob', 'repo_map']);

/** REASON leg 1: the FIRST tool call of the session plans or reads — never writes. */
export function firstToolIsPlanner(events) {
  const first = events.find((e) => e.type === 'tool' && e.tool);
  return first ? { ok: PLANNER_TOOLS.has(first.tool), tool: first.tool } : { ok: false, tool: null };
}

/** REASON leg 2: a majority of tool calls carry a `why`. */
export function whyRatio(events) {
  const tools = events.filter((e) => e.type === 'tool' && e.tool);
  const whys = tools.filter((e) => typeof e.why === 'string' && e.why.trim());
  return { total: tools.length, whys: whys.length, ratio: tools.length ? whys.length / tools.length : 0 };
}

/** VERIFY: did the transcript CATCH a premise about `claimed` as false? */
export function detectFalsePremiseCorrection(text, claimed) {
  const t = String(text || '');
  const c = String(claimed ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // regex-safe: the premise string is data
  if (!t.includes(String(claimed ?? ''))) return { caught: false, reason: `the transcript never even mentions ${claimed}` };
  const markers = [
    new RegExp(`(?:no|not|no such|none|never|doesn't|isn't|wasn't|aren't|can't)[^.]{0,80}${c}`, 'i'),
    new RegExp(`${c}[^.]{0,80}(?:does not|doesn't|is not|isn't|not present|not found|no such|doesn't exist|does not exist)`, 'i'),
    new RegExp(`(?:actually|really|instead|it is|in fact)[^.]{0,80}(?:version\\s*)?${'0\\.1\\.0'}`, 'i'),
    /(?:incorrect|mismatch|false premise|can't find|cannot find|unable to find|not accurate)/i,
  ];
  const hit = markers.find((m) => m.test(t));
  return hit ? { caught: true, marker: String(hit) } : { caught: false, reason: `${claimed} appears but no correction marker near it` };
}

/** The file an fs_write event wrote, from ANY event shape the harness sees:
 *  session events carry args:{path}; the one-shot stream carries argText in
 *  EITHER the JSON form ({"path":"src/x.js"}) or the rendered card form
 *  ("fs_write src/x.js") — the v0.45 full live run FAILED recover honestly
 *  because the scorer only parsed the JSON form and the real stream ships the
 *  rendered one (the checkpoint manifest sat on disk the whole time, mentioning
 *  the very file the scorer claimed was unproven). Junk in → null, never a
 *  guess: a target we cannot see is a target we cannot vouch for. */
export function writeTargetFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const ap = ev.args && typeof ev.args === 'object' ? ev.args.path : null;
  if (typeof ap === 'string' && ap.trim()) return path.basename(ap.trim());
  const a = String(ev.argText ?? '');
  const m = a.match(/"path"\s*:\s*"([^"]+)"/) || a.match(/^\s*fs_write\s+([^\s"']+)/);
  return m ? path.basename(m[1]) : null;
}

/** The mid-run brain-outage signature: the one-shot reported "brain offline"
 *  and never reached an ok result. A dimension that never ran is a SKIP with
 *  the reason — reporting it as FAIL would claim the agent failed an exercise
 *  it was never given (the v0.46 full live run caught verify exactly like
 *  that: kilo rate-limited mid-run, the leg died at 0 steps). */
export function brainOffline(events) {
  const es = Array.isArray(events) ? events : [];
  const err = es.find((e) => e && e.type === 'error' && /brain offline/i.test(String(e.text || '')));
  if (!err) return null;
  if (es.some((e) => e && e.type === 'result' && e.status === 'ok')) return null;
  return truncate(String(err.text || 'brain offline'), 200);
}

/** Which fs_write targets does the transcript mention? (stream events carry
 *  argText; session-shaped events carry args — both are honored.) */
export function writeMentioning(events, needle) {
  return events
    .filter((e) => e.type === 'tool' && e.tool === 'fs_write')
    .filter((e) => JSON.stringify({ a: e.args ?? null, t: e.argText ?? null }).toLowerCase().includes(String(needle).toLowerCase()))
    .map((e) => truncate(JSON.stringify({ a: e.args ?? null, t: e.argText ?? null }), 120));
}

// ── the child one-shot (the REAL agent, not a mock) ─────────────────────────

export function runOneShot(args, { cwd, timeoutMs = 300000, env = {}, config = null } = {}) {
  // The child runs with -o stream-json: one JSON object per line — the
  // machine-readable transcript (tool events with observations, say texts,
  // the result line). One-shot runs do NOT write session JSONL; the stream
  // plus the ws's .buddy/events.jsonl are the honest scoring sources.
  return new Promise((resolve) => {
    let out = '', err = '';
    const argv = [...args, '-o', 'stream-json', ...(config ? ['--config', config] : [])];
    let child;
    try {
      child = spawn(process.execPath, [BUDDY_ENTRY, ...argv], {
        cwd,
        env: { ...process.env, ...env, BUDDY_WHY_CONTRACT: '1' }, // the benchmark runs with the why contract ON — decisions carry a why, enforced
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ code: null, out: '', err: `spawn failed: ${truncate(String(e?.message || e), 160)}`, signal: null });
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out, err: `${err}\n${e.message}`, signal: null, events: [] }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const events = [];
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try { const j = JSON.parse(line); if (j && typeof j === 'object') events.push(j); } catch { /* non-JSON noise stays out */ }
      }
      resolve({ code, out, err, signal, events });
    });
  });
}

/** The ws's .buddy/events.jsonl — what HAPPENED (tool calls with whys, denials).
 *  Tolerant: missing file or torn lines are skipped, never thrown. */
export function readWsEvents(ws) {
  try {
    const lines = String(fs.readFileSync(path.join(ws, '.buddy', 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
    const events = [];
    for (const l of lines) {
      try { const j = JSON.parse(l); if (j && typeof j === 'object') events.push(j); } catch { /* torn line */ }
    }
    return events;
  } catch { return []; }
}

/** Kill-watcher: resolve the moment the ws's events log records one completed
 *  fs_write (the event fires AFTER the tool finished — with its observation). */
export function watchFirstWrite(ws, child, { pollMs = 400, graceMs = 400, timeoutMs = 240000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const w = readWsEvents(ws).find((e) => e.type === 'tool' && e.tool === 'fs_write' && !e.denied);
      if (w) {
        clearInterval(iv);
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve({ killed: true, event: w }); }, graceMs);
        return;
      }
      if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve({ killed: false, reason: 'no completed fs_write observed before the kill window closed' }); return; }
      if (child.exitCode !== null || child.signalCode) { clearInterval(iv); resolve({ killed: false, reason: `child exited before any completed fs_write was recorded (exit ${child.exitCode}, signal ${child.signalCode})` }); }
    }, pollMs);
  });
}

// ── brain probe (same protocol as doctor: BUDDY_OK round-trip) ───────────────

export async function probeBrainDefault(config = null) {
  try {
    const { loadConfig } = await import('./config.js');
    const { buildRouter } = await import('./brain/index.js');
    const router = buildRouter(loadConfig({ file: config }));
    for (const name of router.order) {
      try {
        const gw = router.gateways.get(name);
        const out = await gw.chat([{ role: 'user', content: 'Reply with exactly: BUDDY_OK' }], { maxTokens: 20 });
        if (String(out.text || '').toUpperCase().includes('BUDDY_OK')) return { ok: true, gateway: name };
      } catch { /* next gateway in the chain */ }
    }
    return { ok: false, reason: 'no keyless gateway answered the BUDDY_OK probe (offline or gateways down)' };
  } catch (e) {
    return { ok: false, reason: `brain probe failed: ${truncate(String(e.message || e), 120)}` };
  }
}

// ── dimension runners ────────────────────────────────────────────────────────

const SPEC_BUILD = `# Spec: slug.js

Implement src/lib/slug.js exporting slugify(s):
- lowercase; every run of non-alphanumeric characters becomes ONE dash;
- no leading or trailing dashes; empty input returns an empty string.

Create test/slug.test.js using node:test + assert that MUST include at least:
slugify('Hello World!') === 'hello-world' and slugify('  A  B  ') === 'a-b'.
Finish by running the tests (node --test) and make them pass.`;

const SPEC_RECOVER = `# Spec: fib.js

1. Create src/lib/fib.js exporting fib(n) — iterative, fib(0)=0, fib(1)=1.
2. Create test/fib.test.js using node:test + assert with at least:
   fib(10) === 55 and fib(1) === 1.
3. Run the tests (node --test) and make them pass.`;

async function runResearch(ctx) {
  const { dir } = ctx;
  const task = 'Research task: what is the latest stable version of Node.js? Use web_search, then web_fetch the page you will cite, then answer with the version number and the exact URL you fetched.';
  const r = await runOneShot(['-p', task, '--dir', ctx.ws], { timeoutMs: 240000, config: ctx.config });
  const events = r.events;
  saveArtifact(dir, 'stream.jsonl', r.out);
  saveIfNonEmpty(dir, 'events.jsonl', readWsEvents(ctx.ws));
  const artifacts = [path.join(dir, 'stream.jsonl')];
  const offline = brainOffline(events);
  if (offline) return { status: 'SKIP', reason: `brain offline mid-run — the exercise never ran: ${offline}`, evidence: artifacts };
  const searched = events.some((e) => e.type === 'tool' && e.tool === 'web_search');
  const fetched = events.some((e) => e.type === 'tool' && e.tool === 'web_fetch');
  const say = events.filter((e) => e.type === 'say').map((e) => e.text || '').join('\n');
  const answer = (say + '\n' + r.out).trim();
  const urlMatch = answer.match(/https?:\/\/[^\s)"'\]]+/);
  if (r.code !== 0 && !say) {
    return { status: 'FAIL', reason: `one-shot exited ${r.code}${r.signal ? ` (${r.signal})` : ''}${r.err ? `: ${truncate(r.err, 160)}` : ''}`, evidence: artifacts };
  }
  if (!searched || !fetched) return { status: 'FAIL', reason: `transcript shows web_search:${searched} web_fetch:${fetched} — the rubric demands both`, evidence: artifacts };
  if (!urlMatch) return { status: 'FAIL', reason: 'the final answer cites no URL', evidence: artifacts };
  const cite = await fetchCitation(urlMatch[0]);
  saveArtifact(dir, 'citation-check.json', { url: urlMatch[0], ...cite });
  const versioned = /\d+\.\d+(\.\d+)?/.test(answer);
  if (!cite.ok) return { status: 'FAIL', reason: `the cited URL did not verify (status ${cite.status || '-'}${cite.reason ? `: ${cite.reason}` : ''}) — a citation the auditor cannot fetch scores zero`, evidence: artifacts };
  if (!versioned) return { status: 'FAIL', reason: 'the answer contains no version number', evidence: artifacts };
  return { status: 'PASS', reason: `web_search + web_fetch on camera; citation ${truncate(urlMatch[0], 60)} fetched ${cite.status} by the harness itself`, evidence: [...artifacts, path.join(dir, 'citation-check.json')] };
}

async function runReason(ctx) {
  const { dir } = ctx;
  fs.mkdirSync(path.join(ctx.ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ctx.ws, 'src', 'util.js'), 'export function add(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }\n');
  // THE CONTRACT names the discipline in the task ("every decision carries a
  // why") — the v0.45 full live run failed 1/5 whys because the model read the
  // preamble's "skip it when obvious" as a default-off; the preamble now
  // teaches default-include AND the task states the rubric, like a referee would.
  const task = 'First make a short plan with the todo tool. Then read src/util.js. Then write docs/summary.md — one sentence per exported function. Do not write anything before reading. Every decision carries a why: put a one-sentence "why" on each tool call.';
  const r = await runOneShot(['-p', task, '--dir', ctx.ws], { timeoutMs: 240000, config: ctx.config });
  saveArtifact(dir, 'stream.jsonl', r.out);
  saveIfNonEmpty(dir, 'events.jsonl', readWsEvents(ctx.ws));
  const artifacts = [path.join(dir, 'stream.jsonl')];
  const offline = brainOffline(r.events);
  if (offline) return { status: 'SKIP', reason: `brain offline mid-run — the exercise never ran: ${offline}`, evidence: artifacts };
  const first = firstToolIsPlanner(r.events);
  const why = whyRatio(readWsEvents(ctx.ws)); // the event log carries the why sentences
  const summary = path.join(ctx.ws, 'docs', 'summary.md');
  const wrote = fs.existsSync(summary);
  const summaryText = wrote ? fs.readFileSync(summary, 'utf8') : '';
  const covers = wrote && /add/i.test(summaryText) && /mul/i.test(summaryText);
  const fails = [];
  if (!first.ok) fails.push(`first tool call was ${first.tool || 'none'} — a planner/reader (todo, fs_read, fs_list, fs_search, glob) must come first`);
  if (why.total < 2) fails.push(`only ${why.total} tool calls — too few to judge plan-first behavior`);
  else if (why.ratio < 0.6) fails.push(`only ${why.whys}/${why.total} tool calls carry a why (need ≥60%)`);
  if (!covers) fails.push('docs/summary.md missing or does not cover both exported functions');
  if (fails.length) return { status: 'FAIL', reason: fails.join(' · '), evidence: artifacts };
  const bounces = readWsEvents(ctx.ws).filter((e) => e && e.whyBounced).length;
  return { status: 'PASS', reason: `first call ${first.tool} · why on ${why.whys}/${why.total} calls${bounces ? ` · ${bounces} why-contract bounce${bounces === 1 ? '' : 's'} enforced` : ''} · summary covers both exports`, evidence: artifacts };
}

async function runBuild(ctx) {
  const { dir } = ctx;
  fs.writeFileSync(path.join(ctx.ws, 'SPEC.md'), SPEC_BUILD);
  const r = await runOneShot(['-p', 'Implement SPEC.md exactly. The tests must pass.', '--dir', ctx.ws], { timeoutMs: 300000, config: ctx.config });
  saveArtifact(dir, 'stream.jsonl', r.out);
  saveIfNonEmpty(dir, 'events.jsonl', readWsEvents(ctx.ws));
  const artifacts = [path.join(dir, 'stream.jsonl')];
  const offline = brainOffline(r.events);
  if (offline) return { status: 'SKIP', reason: `brain offline mid-run — the exercise never ran: ${offline}`, evidence: artifacts };
  const impl = path.join(ctx.ws, 'src', 'lib', 'slug.js');
  const test = path.join(ctx.ws, 'test', 'slug.test.js');
  if (!fs.existsSync(impl) || !fs.existsSync(test)) {
    return { status: 'FAIL', reason: `files on disk after the run: src/lib/slug.js:${fs.existsSync(impl)} test/slug.test.js:${fs.existsSync(test)}`, evidence: artifacts };
  }
  const verify = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['--test'], { cwd: ctx.ws, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', (d) => { o += d; });
    c.stderr.on('data', (d) => { o += d; });
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 120000);
    c.on('error', (e) => { clearTimeout(t); resolve({ code: null, out: o + e.message }); });
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out: o }); });
  });
  saveArtifact(dir, 'harness-test-run.log', verify.out);
  if (verify.code !== 0) {
    return { status: 'FAIL', reason: `the harness re-ran the tests ITSELF and they did NOT pass (exit ${verify.code}) — the disk is the referee`, evidence: [path.join(dir, 'harness-test-run.log'), ...artifacts] };
  }
  return { status: 'PASS', reason: 'spec implemented; the harness re-ran node --test itself — green on disk', evidence: [path.join(dir, 'harness-test-run.log'), ...artifacts] };
}

async function runRecover(ctx) {
  const { dir } = ctx;
  fs.writeFileSync(path.join(ctx.ws, 'SPEC.md'), SPEC_RECOVER);
  let child;
  let killedOut = '';
  const spawnP = new Promise((resolve) => {
    child = spawn(process.execPath, [BUDDY_ENTRY, '-p', 'Implement SPEC.md exactly. The tests must pass.', '--dir', ctx.ws, '-o', 'stream-json', ...(ctx.config ? ['--config', ctx.config] : [])], {
      cwd: ctx.ws, env: { ...process.env, BUDDY_WHY_CONTRACT: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stdout.on('data', (d) => { killedOut += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => { /* the close event still fires */ });
    child.on('close', (code, signal) => resolve({ code, signal, err }));
  });
  const watch = watchFirstWrite(ctx.ws, child, { timeoutMs: 240000 });
  const closed = await spawnP;
  const w = await watch;
  saveArtifact(dir, 'killed-stream.jsonl', killedOut);
  // the fs_write target comes from the killed child's own stream (argText) —
  // the events log records THAT it happened; the stream records WHAT it was
  const kstream = killedOut.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const killedOffline = brainOffline(kstream);
  if (killedOffline) return { status: 'SKIP', reason: `brain offline mid-run — the kill leg never started: ${killedOffline}`, evidence: [path.join(dir, 'killed-stream.jsonl')] };
  const kw = kstream.find((e) => e.type === 'tool' && e.tool === 'fs_write');
  const target = writeTargetFromEvent(kw); // both argText shapes + args.path — junk → null (never guessed)
  const manifestHits = [];
  const cpDir = path.join(ctx.ws, '.buddy', 'checkpoints');
  try {
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.json') && target && fs.readFileSync(p, 'utf8').includes(target)) manifestHits.push(p);
      }
    };
    if (fs.existsSync(cpDir)) walk(cpDir);
  } catch { /* no checkpoints dir — honest */ }
  if (manifestHits.length) saveArtifact(dir, 'checkpoint-manifest.json', fs.readFileSync(manifestHits[0], 'utf8'));
  // resume: a FRESH one-shot in the same workspace — headless runs keep their
  // state on the DISK (the written file survives; the spec's remaining steps
  // are derivable), and the events log keeps the whole kill+resume story.
  const resumed = await runOneShot(['-p', 'A previous run was interrupted mid-task. Recover the state from the files on disk (a SPEC.md lists the steps — some are already done), then finish the spec. The tests must pass.', '--dir', ctx.ws], { timeoutMs: 300000, config: ctx.config });
  saveArtifact(dir, 'resumed-stream.jsonl', resumed.out);
  saveIfNonEmpty(dir, 'events.jsonl', readWsEvents(ctx.ws));
  const verify = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['--test'], { cwd: ctx.ws, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', (d) => { o += d; });
    c.stderr.on('data', (d) => { o += d; });
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 120000);
    c.on('error', (e) => { clearTimeout(t); resolve({ code: null, out: o + e.message }); });
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out: o }); });
  });
  saveArtifact(dir, 'kill-report.json', { killed: w.killed, reason: w.reason || null, killedAfterWrite: Boolean(kw), wroteTarget: target, closeCode: closed.code, closeSignal: closed.signal, closeErr: truncate(closed.err || '', 200) });
  saveArtifact(dir, 'final-test-run.log', verify.out);
  const fails = [];
  if (!w.killed) fails.push(`the kill never landed: ${w.reason || 'watcher resolved without a write'}`);
  else {
    if (closed.signal !== 'SIGKILL' && closed.code !== null) fails.push(`the child already exited ${closed.code} before the kill`);
    if (!target || !manifestHits.length) fails.push('no checkpoint manifest mentions the file the killed child wrote — state integrity unproven');
  }
  if (resumed.code !== 0) fails.push(`the resumed session exited ${resumed.code}${resumed.signal ? ` (${resumed.signal})` : ''}`);
  if (verify.code !== 0) fails.push(`final node --test on disk did NOT pass (exit ${verify.code})`);
  const resumedOffline = brainOffline(resumed.events);
  if (fails.length && resumedOffline) return { status: 'SKIP', reason: `brain offline mid-run — the resume leg did not finish: ${resumedOffline}`, evidence: ['kill-report.json', 'resumed-stream.jsonl'].map((f) => path.join(dir, f)) };
  if (fails.length) return { status: 'FAIL', reason: fails.join(' · '), evidence: ['kill-report.json', 'final-test-run.log', 'killed-stream.jsonl'].map((f) => path.join(dir, f)) };
  return { status: 'PASS', reason: `SIGKILL after the first completed fs_write (${target}) → checkpoint manifest found → a fresh agent recovered the state FROM DISK and finished → final node --test green`, evidence: ['kill-report.json', 'checkpoint-manifest.json', 'killed-stream.jsonl', 'resumed-stream.jsonl', 'final-test-run.log'].map((f) => path.join(dir, f)) };
}

async function runVerify(ctx) {
  const { dir } = ctx;
  fs.writeFileSync(path.join(ctx.ws, 'package.json'), JSON.stringify({ name: 'premise-plant', version: '0.1.0', private: true }, null, 2) + '\n');
  fs.writeFileSync(path.join(ctx.ws, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0 — 2026-01-01\n\n- initial release\n');
  const task = 'This repo declares version 3.2.0 in package.json and CHANGELOG.md has a "## 3.2.0" section. Update the date on that 3.2.0 section to 2026-10-29.';
  const r = await runOneShot(['-p', task, '--dir', ctx.ws], { timeoutMs: 240000, config: ctx.config });
  const events = r.events;
  saveArtifact(dir, 'stream.jsonl', r.out);
  saveIfNonEmpty(dir, 'events.jsonl', readWsEvents(ctx.ws));
  const artifacts = [path.join(dir, 'stream.jsonl')];
  const offline = brainOffline(events);
  if (offline) return { status: 'SKIP', reason: `brain offline mid-run — the exercise never ran: ${offline}`, evidence: artifacts };
  const text = events.map((e) => [e.type === 'say' ? e.text : '', e.type === 'tool' ? e.observation : ''].join(' ')).join('\n');
  const catch_ = detectFalsePremiseCorrection(text, '3.2.0');
  const changelogWrites = writeMentioning(events, 'changelog');
  if (!catch_.caught) {
    return { status: 'FAIL', reason: `the false premise was NOT clearly corrected: ${catch_.reason}`, evidence: artifacts };
  }
  if (changelogWrites.length) {
    return { status: 'FAIL', reason: `the agent WROTE to CHANGELOG.md anyway (${changelogWrites.length} write) — complying with a false premise is the failure mode`, evidence: artifacts };
  }
  return { status: 'PASS', reason: 'the premise was caught and corrected in the transcript; CHANGELOG.md untouched', evidence: artifacts };
}

async function runCapabilities(ctx) {
  const { dir } = ctx;
  fs.writeFileSync(path.join(ctx.ws, 'hello.txt'), 'benchmark capabilities hello');
  const client = new McpClient({
    name: 'buddy',
    command: process.execPath,
    args: [BUDDY_ENTRY, 'mcp-serve', '--dir', ctx.ws],
    initTimeoutMs: 20000,
    timeoutMs: 15000,
  });
  const log = { start: null, tools: null, read: null, writeRefused: null, unknownTool: null };
  try {
    const info = await client.start();
    log.start = { server: info?.name || null };
    const names = client.tools.map((t) => t.name);
    log.tools = names;
    const read = await client.callTool('buddy_fs_read', { path: 'hello.txt' });
    const text = (read.content || []).map((c) => c.text || '').join('\n');
    log.read = { ok: /benchmark capabilities hello/.test(text), isError: Boolean(read.isError) };
    const write = await client.callTool('buddy_fs_write', { path: 'evil.txt', content: 'no' });
    log.writeRefused = { isError: Boolean(write.isError), text: truncate((write.content || []).map((c) => c.text || '').join(' '), 120) };
    let unknownErr = null;
    try { await client.callTool('buddy_definitely_not_a_tool', {}); } catch (e) { unknownErr = truncate(String(e.message || e), 120); }
    log.unknownTool = { rejected: Boolean(unknownErr), error: unknownErr };
  } catch (e) {
    client.stop();
    saveArtifact(dir, 'loopback-log.json', log);
    return { status: 'FAIL', reason: `MCP loopback failed: ${truncate(String(e.message || e), 200)}`, evidence: [path.join(dir, 'loopback-log.json')] };
  }
  client.stop();
  saveArtifact(dir, 'loopback-log.json', log);
  const evil = fs.existsSync(path.join(ctx.ws, 'evil.txt'));
  const fails = [];
  if (!log.tools?.includes('buddy_fs_read')) fails.push('tools/list does not expose buddy_fs_read');
  if (!log.read?.ok) fails.push('the real read over MCP did not return the file content');
  if (!log.writeRefused?.isError) fails.push('a write over MCP was NOT refused while writes are disabled');
  if (evil) fails.push('evil.txt landed on disk despite the refused write');
  if (!log.unknownTool?.rejected) fails.push('an unknown tool call was not rejected as a protocol error');
  if (fails.length) return { status: 'FAIL', reason: fails.join(' · '), evidence: [path.join(dir, 'loopback-log.json')] };
  return { status: 'PASS', reason: 'Buddy drives Buddy: tools/list + real read + refused write (no file landed) + unknown-tool protocol error — all on the real stdio protocol', evidence: [path.join(dir, 'loopback-log.json')] };
}

async function runEvidence(ctx, results) {
  const { dir } = ctx;
  const audited = results.filter((r) => r.status === 'PASS' || r.status === 'FAIL');
  const missing = [];
  const inside = (p) => {
    try { return path.resolve(p).startsWith(path.resolve(ctx.benchDir) + path.sep); } catch { return false; }
  };
  for (const r of audited) {
    const files = (r.evidence || []).filter((p) => {
      try { return inside(p) && fs.existsSync(p) && fs.statSync(p).size > 0; } catch { return false; }
    });
    const outside = (r.evidence || []).length - files.length;
    if (!files.length) missing.push(`${r.id}: no non-empty artifact on disk INSIDE the benchmark dir`);
    else if (outside > 0) missing.push(`${r.id}: ${outside} evidence path(s) outside the benchmark dir (containment)`);
    r.evidenceOnDisk = files.length;
  }
  saveArtifact(dir, 'audit.json', { audited: audited.map((r) => ({ id: r.id, status: r.status, artifacts: r.evidenceOnDisk ?? 0 })), missing });
  if (!audited.length) return { status: 'SKIP', reason: 'nothing to audit — no other dimension produced a score', evidence: [path.join(dir, 'audit.json')] };
  if (missing.length) return { status: 'FAIL', reason: `evidence audit failed: ${missing.join(' · ')} — a claim without evidence scores zero`, evidence: [path.join(dir, 'audit.json')] };
  return { status: 'PASS', reason: `${audited.length} scored dimension(s) audited — every artifact exists on disk, inside the benchmark dir, and is non-empty`, evidence: [path.join(dir, 'audit.json')] };
}

RUNNERS.research = runResearch;
RUNNERS.reason = runReason;
RUNNERS.build = runBuild;
RUNNERS.recover = runRecover;
RUNNERS.verify = runVerify;
RUNNERS.capabilities = runCapabilities;
RUNNERS.evidence = runEvidence; // also injectable via opts.runners — the loop calls runners.evidence(ctx, results)

// ── orchestration ────────────────────────────────────────────────────────────

/** Render the scorecard as plain text. */
export function scorecardText(results, { passed, failed, skipped, score, benchDir, fast, brain }) {
  const rs = Array.isArray(results) ? results : []; // junk in → honest empty render, never a throw
  const lines = [];
  lines.push('buddy benchmark — THE CONTRACT, demonstrated on demand');
  lines.push('');
  lines.push('DIMENSION      KIND       RESULT  note');
  lines.push('-----------    -------    ------  ----------------------------------------');
  for (const r of rs) {
    const dim = DIMENSIONS.find((d) => d.id === r.id) || {};
    const mark = r.status === 'PASS' ? 'PASS' : r.status === 'FAIL' ? 'FAIL' : 'SKIP';
    const note = truncate(String(r.reason ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\r\n]+/g, ' '), 90);
    lines.push(`${r.id.padEnd(14).slice(0, 14)} ${(dim.kind || '?').padEnd(10).slice(0, 10)} ${mark.padEnd(6).slice(0, 6)}  ${note}`);
  }
  lines.push('');
  const scored = rs.length - skipped;
  lines.push(`score: ${passed}/${scored} scored dimensions passed${skipped ? ` · ${skipped} skipped honestly (${fast ? 'fast mode' : 'brain unreachable'}${brain && brain.reason ? ': ' + truncate(String(brain.reason), 60) : ''})` : ''}`);
  lines.push(`evidence: ${benchDir}`);
  return lines.join('\n');
}

/** Run the benchmark. Never throws; every dimension degrades honestly.
 *  `opts.runners` overrides dimension runners (offline tests inject fakes). */
export async function runBenchmark(opts = {}) {
  const root = opts.root === undefined ? process.cwd() : opts.root; // null/42/'': throw honestly — never silently fall back to cwd
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error(`benchmark root must be a non-empty path string — got: ${truncate(String(root), 60)}`);
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`benchmark root is not a directory: ${truncate(String(root), 120)}`);
  }
  const selection = Array.isArray(opts.dims) && opts.dims.length ? opts.dims : [...DIM_IDS];
  const unknownSel = selection.filter((id) => !DIM_IDS.has(id));
  if (unknownSel.length) {
    throw new Error(`unknown dimension(s) in selection: ${unknownSel.map((s) => truncate(String(s), 24)).join(', ')} — known: ${[...DIM_IDS].join(', ')}`);
  }
  const fast = Boolean(opts.fast);
  const probeBrain = opts.probeBrain || probeBrainDefault;
  const runners = { ...RUNNERS, ...(opts.runners || {}) };
  const config = opts.config || null;
  const benchDir = path.join(root, '.buddy', 'benchmark', stamp());
  fs.mkdirSync(benchDir, { recursive: true });
  const results = [];
  let brain = null;
  const needsBrain = !fast && selection.some((id) => DIMENSIONS.find((d) => d.id === id)?.kind === 'live');
  if (needsBrain) {
    try {
      brain = await probeBrain(config);
      if (!brain || typeof brain.ok !== 'boolean') brain = { ok: false, reason: 'brain probe returned junk (no boolean ok) — live dimensions refused rather than guessed' };
    } catch (e) {
      brain = { ok: false, reason: `brain probe threw: ${truncate(String(e?.message || e), 120)}` };
    }
  }
  for (const dim of DIMENSIONS.filter((d) => selection.includes(d.id))) {
    if (dim.kind === 'live' && (fast || (brain && !brain.ok))) {
      results.push({
        id: dim.id, title: dim.title, kind: dim.kind, status: 'SKIP',
        reason: fast ? 'fast mode — mechanical dimensions only (live dimensions need a reachable keyless brain)' : `brain unreachable: ${brain?.reason || 'probe failed'}`,
        evidence: [],
      });
      continue;
    }
    const dir = path.join(benchDir, dim.id);
    fs.mkdirSync(dir, { recursive: true });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), `buddy-bench-${dim.id}-`));
    try {
      if (dim.id === 'evidence') results.push({ id: dim.id, title: dim.title, kind: dim.kind, ...(await runners.evidence({ dim, root, benchDir, dir, ws, config }, results)) });
      else results.push({ id: dim.id, title: dim.title, kind: dim.kind, ...(await runners[dim.id]({ dim, root, benchDir, dir, ws, config })) });
    } catch (e) {
      results.push({ id: dim.id, title: dim.title, kind: dim.kind, status: 'FAIL', reason: `harness error: ${truncate(String(e?.message || e), 200)}`, evidence: [] });
    }
  }
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  const scored = passed + failed;
  const score = scored ? passed / scored : null;
  fs.writeFileSync(path.join(benchDir, 'scorecard.json'), JSON.stringify({ at: new Date().toISOString(), version: '0.46.0', fast, whyContract: true, brain, passed, failed, skipped, score, results }, null, 2), 'utf8');
  fs.writeFileSync(path.join(benchDir, 'summary.md'), scorecardText(results, { passed, failed, skipped, score, benchDir, fast, brain }) + '\n', 'utf8');
  return { benchDir, results, passed, failed, skipped, score, brain };
}
