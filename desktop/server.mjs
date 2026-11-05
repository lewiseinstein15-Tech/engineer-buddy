#!/usr/bin/env node
// Buddy Desktop server — local, zero-dependency bridge between the UI and the
// real engineer-buddy engine. Spawns `node src/index.js -p <task> -o stream-json`
// per task, forwards events over SSE, enriches them with the engine's own
// event log (.buddy/events.jsonl: the model's "why", gateway/model facts,
// routing), persists replayable sessions, and exposes workspace git + GitHub
// account endpoints. No engine code is changed.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7822;
const WORKSPACE = process.env.BUDDY_WORKSPACE || '/tmp/buddy-workspace';
// engine: env override > sibling engineer-buddy checkout > the repo checkout this folder is part of
const ENGINE = process.env.ENGINEER_BUDDY_PATH
  || [path.join(__dirname, '..', 'engineer-buddy'), path.join(__dirname, '..')]
      .find((p) => fs.existsSync(path.join(p, 'src', 'index.js')))
  || path.join(__dirname, '..');
const ENGINE_SRC = path.join(ENGINE, 'src', 'index.js');
const APP_DIR = path.join(WORKSPACE, '.buddy-desktop');
const SESSIONS_DIR = path.join(APP_DIR, 'sessions');
const BRAIN_FILE = path.join(APP_DIR, 'brain.json');
const GH_FILE = path.join(APP_DIR, 'github.json');
const BRAIN_CFG_FILE = path.join(APP_DIR, 'buddy.config.json');
const EVENTS_LOG = path.join(WORKSPACE, '.buddy', 'events.jsonl');

const DEFAULT_CHAIN = ['kilo', 'llm7', 'pollinations', 'duckai'];
const KNOWN = ['kilo', 'llm7', 'pollinations', 'duckai', 'ollama'];

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
for (const f of [GH_FILE]) { try { fs.chmodSync(f, 0o600); } catch {} }

let version = '0.0.0';
try { version = JSON.parse(fs.readFileSync(path.join(ENGINE, 'package.json'), 'utf8')).version; } catch {}

// ---------------------------------------------------------------- helpers --
const j = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(b); };
const readBody = (req) => new Promise((ok, bad) => { let s = ''; req.on('data', (d) => { s += d; if (s.length > 1e6) { bad(new Error('too large')); req.destroy(); } }); req.on('end', () => ok(s)); req.on('error', bad); });
const bodyJson = async (req) => { const s = await readBody(req); return s ? JSON.parse(s) : {}; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';
const sh = (cmd, args, opts = {}) => new Promise((ok) => {
  const c = spawn(cmd, args, { cwd: WORKSPACE, ...opts });
  let out = '', err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => ok({ code, out: out.slice(0, 20000), err: err.slice(0, 4000) }));
  c.on('error', (e) => ok({ code: 127, out: '', err: String(e) }));
});

// ------------------------------------------------------------------ brain --
function readBrain() {
  try { return { ...{ order: [...DEFAULT_CHAIN], disabled: [], models: {}, custom: { enabled: false, baseUrl: '', apiKey: '', model: '' } }, ...JSON.parse(fs.readFileSync(BRAIN_FILE, 'utf8')) }; }
  catch { return { order: [...DEFAULT_CHAIN], disabled: [], models: {}, custom: { enabled: false, baseUrl: '', apiKey: '', model: '' } }; }
}
function brainCustomized(b) {
  const chain = b.order.filter((g) => !b.disabled.includes(g));
  return JSON.stringify(chain) !== JSON.stringify(DEFAULT_CHAIN)
    || Object.keys(b.models).some((k) => b.models[k])
    || Boolean(b.custom && b.custom.enabled);
}
function brainPreview(b) {
  const chain = b.order.filter((g) => !b.disabled.includes(g));
  return chain.map((g) => {
    if (g === 'kilo' && b.custom && b.custom.enabled) return `kilo(custom:${b.custom.model})`;
    return b.models[g] ? `${g}(${b.models[g]})` : g;
  }).join(' → ') || '(all disabled)';
}
// Custom provider rides the kilo slot: kilo is OpenAI-compatible —
// POST {baseUrl}/v1/chat/completions with Bearer auth — so any compatible
// endpoint can be pointed at it without touching engine code.
function writeBrainConfig(b) {
  const gateways = {};
  for (const g of KNOWN) {
    const gw = { enabled: !b.disabled.includes(g) && b.order.includes(g) };
    const model = b.models[g] || (g === 'kilo' && b.custom.enabled ? b.custom.model : '');
    if (model) gw.models = [model];
    if (g === 'kilo' && b.custom.enabled) {
      gw.baseUrl = b.custom.baseUrl;
      if (b.custom.apiKey) gw.apiKey = b.custom.apiKey;
      gw.enabled = true;
    }
    gateways[g] = gw;
  }
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(BRAIN_CFG_FILE, JSON.stringify({ gateways }, null, 2));
  return BRAIN_CFG_FILE;
}
function launchEnv(b) {
  const env = { ...process.env };
  if (brainCustomized(b)) {
    env.BUDDY_GATEWAY_ORDER = b.order.filter((g) => !b.disabled.includes(g)).join(',');
    env.BUDDY_DISABLE_GATEWAYS = b.disabled.join(',');
  }
  return env;
}

// ------------------------------------------------------------------- runs --
const runs = new Map(); // id -> { log:[], res, child, started, code, secs, tools, said, diff, whyPending }

function sse(res, ev) { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} }

function record(id, ev) { const r = runs.get(id); if (r) r.log.push(ev); }

function parsePlan(obs) {
  const m = /PLAN \((\d+)\/(\d+) done\):/.exec(obs || '');
  if (!m) return null;
  const items = [];
  for (const line of String(obs).split('\n')) {
    const im = /^- \[( |x|~)\] (.+)$/.exec(line.trim());
    if (im) items.push({ state: im[1] === 'x' ? 'done' : im[1] === '~' ? 'active' : 'pending', text: im[2].replace(/^#\d+\s*/, '') });
  }
  return { done: +m[1], total: +m[2], items };
}

function tailEventLog(id, child) {
  const r = runs.get(id);
  let offset = 0;
  try { offset = fs.statSync(EVENTS_LOG).size; } catch {}
  let buf = '';
  const timer = setInterval(() => {
    if (!runs.has(id)) { clearInterval(timer); return; }
    let size = 0; try { size = fs.statSync(EVENTS_LOG).size; } catch { return; }
    if (size <= offset) { if (child.exitCode !== null && size <= offset) { clearInterval(timer); } return; }
    let fd; try { fd = fs.openSync(EVENTS_LOG, 'r'); } catch { return; }
    try {
      const len = Math.min(size - offset, 2e6);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, offset);
      offset += len;
      buf += b.toString('utf8');
    } finally { fs.closeSync(fd); }
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'tool') {
        if (ev.why || ev.gateway || ev.model) {
          const enriched = { type: 'why', tool: ev.tool, why: ev.why || null, gateway: ev.gateway || null, model: ev.model || null };
          record(id, enriched); sse(r.res, enriched);
        }
      } else if (ev.type === 'route') {
        const enriched = { type: 'routelog', class: ev.class, effort: ev.effort, chain: ev.chain };
        record(id, enriched); sse(r.res, enriched);
      }
    }
  }, 150);
  return timer;
}

function runTask(body) {
  const task = String(body.task || '').trim();
  if (!task) return { error: 'empty task' };
  const files = (Array.isArray(body.files) ? body.files : []).filter((f) => typeof f === 'string' && !f.includes('..')).slice(0, 20);
  const yolo = Boolean(body.yolo);
  const prompt = files.length ? `${task}\n\nfiles to look at: ${files.map((f) => `@${f}`).join(', ')}` : task;

  const id = crypto.randomUUID();
  const brain = readBrain();
  const args = [ENGINE_SRC, '-p', prompt, '-o', 'stream-json'];
  if (yolo) args.push('--yolo');
  if (brainCustomized(brain)) args.push('--config', writeBrainConfig(brain));

  const r = {
    log: [], res: null, started: Date.now(), code: null, secs: 0, tools: 0, said: null,
    diff: null, child: null, task, files, yolo, todos: null,
  };
  runs.set(id, r);

  r.child = spawn('node', args, { cwd: WORKSPACE, env: launchEnv(brain) });
  let out = '';
  r.child.stdout.on('data', (d) => {
    out += d.toString();
    const lines = out.split('\n');
    out = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'tool' && ev.tool === 'todo') {
        const plan = parsePlan(ev.observation);
        if (plan) { r.todos = plan; const t = { type: 'todos', ...plan }; record(id, t); sse(r.res, t); }
      }
      if (ev.type === 'tool') r.tools++;
      if (ev.type === 'say') r.said = ev.text;
      // Live thoughts (engine v0.69.1): display-only narration snapshots —
      // they ride the SSE to the UI but stay out of the saved session log,
      // so replays keep the real event trail without ~8 rows/s of noise.
      if (ev.type === 'stream') { sse(r.res, ev); continue; }
      record(id, ev); sse(r.res, ev);
    }
  });
  r.child.stderr.on('data', (d) => { const e = { type: 'stderr', text: d.toString().slice(0, 2000) }; record(id, e); sse(r.res, e); });
  const tail = tailEventLog(id, r.child);
  r.child.on('close', async (code) => {
    clearInterval(tail);
    r.code = code;
    r.secs = (Date.now() - r.started) / 1000;
    const diff = await sh('git', ['diff', '--unified=3']);
    const st = await sh('git', ['status', '--porcelain']);
    r.diff = `${diff.out}${st.out}`.trim() || null;
    const end = { type: 'run_end', code, secs: r.secs, tools: r.tools, diff: r.diff };
    record(id, end); sse(r.res, end);
    const sid = `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(task)}.json`;
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(path.join(SESSIONS_DIR, sid), JSON.stringify({
        id: sid, task, files, yolo, started: r.started, code, secs: r.secs, tools: r.tools, said: r.said, todos: r.todos, log: r.log,
      }));
      sse(r.res, { type: 'session_saved', id: sid });
    } catch {}
    setTimeout(() => runs.delete(id), 60000);
  });
  return { id };
}

// ------------------------------------------------------------------ replays --
function sessionList() {
  // The workspace (and with it .buddy-desktop/) can be re-seeded while the
  // server is up — recreate the sessions dir instead of 500-ing.
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const out = [];
  for (const f of fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse()) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      out.push({ id: s.id, task: s.task, files: s.files, yolo: s.yolo, code: s.code, secs: s.secs, tools: s.tools, started: s.started, said: s.said });
    } catch {}
  }
  return out;
}

// ------------------------------------------------------------------- files --
function listFiles() {
  const out = [];
  const skip = new Set(['.git', 'node_modules', '.buddy', '.buddy-desktop']);
  const walk = (dir, depth) => {
    if (depth > 3 || out.length > 500) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of ents) {
      if (e.name.startsWith('.') && skip.has(e.name)) continue;
      const rel = path.relative(WORKSPACE, path.join(dir, e.name));
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
      else { out.push(rel); if (out.length > 500) return; }
    }
  };
  walk(WORKSPACE, 0);
  return out;
}

// --------------------------------------------------------------------- git --
async function gitStatus() {
  const st = await sh('git', ['rev-parse', '--is-inside-work-tree']);
  if (st.code !== 0) return { hasRepo: false };
  const branch = (await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  const dirty = (await sh('git', ['status', '--porcelain'])).out.trim().split('\n').filter(Boolean);
  const remote = (await sh('git', ['remote', 'get-url', 'origin'])).out.trim();
  const ab = (await sh('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], )).out.trim().split(/\s+/);
  return {
    hasRepo: true, branch, dirty: dirty.slice(0, 50), dirtyCount: dirty.length,
    remote: remote || null, ahead: +ab[0] || 0, behind: +ab[1] || 0,
  };
}
function readGh() { try { return JSON.parse(fs.readFileSync(GH_FILE, 'utf8')); } catch { return null; } }
function pushUrl(remote, gh) {
  const m = /^https:\/\/github\.com\/(.+?)(\.git)?\/?$/.exec(remote || '');
  if (!m) return null;
  return `https://${encodeURIComponent(gh.login)}:${encodeURIComponent(gh.token)}@github.com/${m[1]}.git`;
}

// ------------------------------------------------------------------ server --
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/' || p === '/app.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'app.html')).pipe(res);
    return;
  }

  // static app assets (PWA + launcher icons) — basename only, no traversal
  if (p === '/manifest.webmanifest' || p === '/sw.js' || p === '/favicon.ico' || p === '/favicon.png' || p.startsWith('/icons/')) {
    const TYPES = { '.webmanifest': 'application/manifest+json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };
    const f = p === '/favicon.ico' || p === '/favicon.png' ? 'icon-32.png' : p === '/manifest.webmanifest' ? 'manifest.webmanifest' : p === '/sw.js' ? 'sw.js' : path.basename(p);
    const fp = path.join(__dirname, f === 'manifest.webmanifest' || f === 'sw.js' ? '.' : 'app-icons', f);
    if (fs.existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(fp).pipe(res);
      return;
    }
  }

  try {
    if (p === '/api/health') {
      // v0.69.3: re-read the engine version per health poll — the cached one
      // kept saying "engine v0.69.1" after a git pull until the server itself
      // was restarted, making the chip lie about what the next run will use.
      try { version = JSON.parse(fs.readFileSync(path.join(ENGINE, 'package.json'), 'utf8')).version || version; } catch {}
      return j(res, 200, { ok: true, engine: ENGINE, version, workspace: WORKSPACE, chain: brainPreview(readBrain()) });
    }
    if (p === '/api/brain' && req.method === 'GET') {
      const b = readBrain();
      return j(res, 200, { defaults: DEFAULT_CHAIN, known: KNOWN, current: b, preview: brainPreview(b), customized: brainCustomized(b) });
    }
    if (p === '/api/brain' && req.method === 'POST') {
      const b = await bodyJson(req);
      const nb = {
        order: Array.isArray(b.order) ? b.order.filter((g) => KNOWN.includes(g)) : readBrain().order,
        disabled: Array.isArray(b.disabled) ? b.disabled.filter((g) => KNOWN.includes(g)) : [],
        models: {},
        custom: {
          enabled: Boolean(b.custom && b.custom.enabled),
          baseUrl: String(b.custom && b.custom.baseUrl || '').trim(),
          apiKey: String(b.custom && b.custom.apiKey || '').trim(),
          model: String(b.custom && b.custom.model || '').trim(),
        },
      };
      for (const g of KNOWN) if (b.models && b.models[g]) nb.models[g] = String(b.models[g]).slice(0, 120);
      if (nb.custom.enabled && (!/^https?:\/\//.test(nb.custom.baseUrl) || !nb.custom.model)) return j(res, 400, { error: 'custom provider needs a base URL (https://…) and a model' });
      fs.mkdirSync(APP_DIR, { recursive: true });
      fs.writeFileSync(BRAIN_FILE, JSON.stringify(nb, null, 2));
      return j(res, 200, { ok: true, preview: brainPreview(nb), customized: brainCustomized(nb) });
    }
    if (p === '/api/files') return j(res, 200, listFiles());
    if (p === '/api/sessions' && req.method === 'GET') return j(res, 200, sessionList());
    if (p === '/api/sessions' && req.method === 'DELETE') {
      for (const f of fs.readdirSync(SESSIONS_DIR)) fs.unlinkSync(path.join(SESSIONS_DIR, f));
      return j(res, 200, { ok: true });
    }
    if (p.startsWith('/api/session/')) {
      const id = decodeURIComponent(p.slice('/api/session/'.length));
      try { return j(res, 200, JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, path.basename(id)), 'utf8'))); }
      catch { return j(res, 404, { error: 'no such session' }); }
    }
    if (p === '/api/run' && req.method === 'POST') {
      const active = [...runs.values()].find((r) => r.code === null);
      if (active) return j(res, 409, { error: 'a run is already in progress' });
      const body = await bodyJson(req);
      const r = runTask(body);
      if (r.error) return j(res, 400, r);
      return j(res, 200, { id: r.id });
    }
    if (p.startsWith('/api/stream/')) {
      const id = p.slice('/api/stream/'.length);
      const r = runs.get(id);
      if (!r) return j(res, 404, { error: 'no such run' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      r.res = res;
      for (const ev of r.log) sse(res, ev);
      if (r.code !== null && !r.log.some((e) => e.type === 'run_end')) { sse(res, { type: 'run_end', code: r.code, secs: r.secs, tools: r.tools, diff: r.diff }); }
      return;
    }
    if (p === '/api/git/status') return j(res, 200, await gitStatus());
    if (p === '/api/git/commit' && req.method === 'POST') {
      const { message } = await bodyJson(req);
      if (!String(message || '').trim()) return j(res, 400, { error: 'commit message required' });
      await sh('git', ['add', '-A']);
      const c = await sh('git', ['commit', '-m', String(message).slice(0, 300)]);
      return j(res, 200, { ok: c.code === 0, out: (c.out + c.err).trim() });
    }
    if (p === '/api/git/push' && req.method === 'POST') {
      const st = await gitStatus();
      if (!st.hasRepo) return j(res, 400, { error: 'workspace is not a git repo' });
      const gh = readGh();
      const auth = gh && pushUrl(st.remote, gh);
      const cmd = auth ? ['push', auth, `HEAD:refs/heads/${st.branch}`] : ['push', '-u', 'origin', `HEAD:refs/heads/${st.branch}`];
      const out = await sh('git', cmd);
      return j(res, 200, { ok: out.code === 0, out: ((out.out + out.err).replace(/\/\/[^@]+@/g, '//***@')).trim() });
    }
    if (p === '/api/github' && req.method === 'GET') { const gh = readGh(); return j(res, 200, gh ? { login: gh.login, avatar: gh.avatar } : { connected: false }); }
    if (p === '/api/github/connect' && req.method === 'POST') {
      const { token } = await bodyJson(req);
      if (!String(token || '').trim()) return j(res, 400, { error: 'paste a GitHub personal access token' });
      let r; try { r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${String(token).trim()}`, 'User-Agent': 'buddy-desktop', Accept: 'application/vnd.github+json' } }); }
      catch (e) { return j(res, 502, { error: `cannot reach api.github.com: ${e.message}` }); }
      if (!r.ok) return j(res, 401, { error: `GitHub rejected the token (HTTP ${r.status})` });
      const u = await r.json();
      fs.mkdirSync(APP_DIR, { recursive: true });
      fs.writeFileSync(GH_FILE, JSON.stringify({ login: u.login, avatar: u.avatar_url, token: String(token).trim() }));
      try { fs.chmodSync(GH_FILE, 0o600); } catch {}
      return j(res, 200, { ok: true, login: u.login, avatar: u.avatar_url });
    }
    if (p === '/api/github/disconnect' && req.method === 'POST') { try { fs.unlinkSync(GH_FILE); } catch {} return j(res, 200, { ok: true }); }
    if (p === '/api/github/create' && req.method === 'POST') {
      const { name, isPrivate } = await bodyJson(req);
      const gh = readGh();
      if (!gh) return j(res, 400, { error: 'connect your GitHub account first' });
      const rn = String(name || '').trim().replace(/[^a-zA-Z0-9._-]/g, '-');
      if (!rn) return j(res, 400, { error: 'repository name required' });
      let r; try { r = await fetch('https://api.github.com/user/repos', { method: 'POST', headers: { Authorization: `Bearer ${gh.token}`, 'User-Agent': 'buddy-desktop', Accept: 'application/vnd.github+json' }, body: JSON.stringify({ name: rn, private: Boolean(isPrivate) }) }); }
      catch (e) { return j(res, 502, { error: e.message }); }
      if (r.status !== 201) return j(res, r.status, { error: `GitHub said HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` });
      const repo = await r.json();
      await sh('git', ['remote', 'remove', 'origin']).catch?.(() => {});
      const rm = await sh('git', ['remote', 'add', 'origin', repo.clone_url]);
      return j(res, 200, { ok: rm.code === 0, url: repo.html_url, out: `remote origin → ${repo.clone_url}` });
    }
    return j(res, 404, { error: 'not found' });
  } catch (e) {
    return j(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`buddy-desktop  http://127.0.0.1:${PORT}  engine v${version}  workspace ${WORKSPACE}`);
});
