// browser.js — the browser automation tool (v0.42.0, checklist §10):
// "Playwright/Puppeteer via an MCP server (not bundled — zero-dep core stays
// clean); screenshots feed the image-input path."
//
// Zero-dep by construction, same law as the db tool: Buddy never bundles
// drivers. The browser driver is THE PROJECT'S OWN playwright or puppeteer
// (node_modules probed at call time); the driver loads only inside a spawned
// child (cwd = project root), so the core process stays zero-dep no matter
// what. Absent driver → honest refusal naming `npm i -D playwright`.
// An MCP browser server (e.g. a playwright-mcp configured in .buddy) remains
// the other route — it composes through the existing `mcp` tool unchanged.
//
// One call = one ordered list of steps run in ONE child: open a URL, click,
// type, eval JS, wait, screenshot, pull page text. Steps are validated in the
// parent BEFORE the child exists (bad steps never reach a browser).
//
// Safety model mirrors the db read/write split:
//   read steps  — open / screenshot / wait / text : gate-free; URLs are
//                 SSRF-guarded with the same blockedHost list as web.js
//                 (localhost, private ranges, cloud metadata refused);
//                 file:// is allowed — it reaches nothing on the network.
//   act steps   — click / type / eval : riskyWhen → approval gate, because a
//                 click can submit a form and an eval can do anything.
//   Secrets: never type credentials into pages — tool args land in the
//   transcript; vault refs are for http auth, not web forms.
//
// Screenshots are written INSIDE the project (default .buddy/browser/) so the
// image-input path can pick them up: @mention the reported path and the PNG
// rides to the model as a vision payload (terminal/mentions.js attachOne).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { blockedHost } from './web.js';
import { truncate } from '../util.js';

export const MAX_STEPS = 12;
export const MAX_EVAL = 4000;
export const MAX_TEXT = 1200;
export const MAX_WAIT_MS = 10000;
export const MIN_DIM = 200;
export const MAX_DIM = 3840;
export const MAX_SHOT_BYTES = 8 * 1024 * 1024;
export const CHILD_TIMEOUT_MS = 60000;
const READ_ACTIONS = new Set(['open', 'screenshot', 'wait', 'text']);
const ACT_ACTIONS = new Set(['click', 'type', 'eval']);
const KNOWN_ACTIONS = new Set([...READ_ACTIONS, ...ACT_ACTIONS]);

/** SSRF-guarded URL check. http/https go through blockedHost; file:// is
 *  allowed (local by definition, no network); everything else is refused. */
export function checkUrl(raw) {
  const u = String(raw || '').trim();
  if (!u) return { ok: false, error: 'url required' };
  let parsed;
  try { parsed = new URL(u); } catch { return { ok: false, error: `not a URL: ${truncate(u, 80)}` }; }
  const scheme = parsed.protocol.replace(':', '');
  if (scheme === 'file') return { ok: true, url: parsed.href, scheme };
  if (scheme !== 'http' && scheme !== 'https') {
    return { ok: false, error: `scheme "${scheme}" refused — only http, https and file:// URLs are allowed` };
  }
  if (blockedHost(parsed.hostname)) {
    return { ok: false, error: `requests to local/internal addresses are blocked (${truncate(parsed.hostname, 60)}) — same SSRF guard as web_fetch` };
  }
  return { ok: true, url: parsed.href, scheme };
}

/** Resolve one step from raw args into a validated command step. */
export function parseStep(raw, { root, seq = 0, defaultShotDir = '.buddy/browser' } = {}) {
  const action = String(raw?.action || '').trim().toLowerCase();
  if (!KNOWN_ACTIONS.has(action)) {
    return { ok: false, error: `unknown step action "${truncate(String(raw?.action || ''), 24)}" — known: open, click, type, eval, wait, text, screenshot` };
  }
  const step = { action };
  if (action === 'open') {
    const u = checkUrl(raw?.url);
    if (!u.ok) return { ok: false, error: u.error };
    step.url = u.url;
  } else if (action === 'click' || action === 'type') {
    const sel = String(raw?.selector || '').trim();
    if (!sel) return { ok: false, error: `${action} needs a {"selector":"css or text selector"}` };
    if (sel.length > 300) return { ok: false, error: 'selector too long (300 char cap)' };
    step.selector = sel;
    if (action === 'type') {
      const text = String(raw?.text ?? '');
      if (!text) return { ok: false, error: 'type needs {"text":"…"} — and never type secrets: tool args land in the transcript' };
      step.text = text.slice(0, 2000);
    }
  } else if (action === 'eval') {
    const js = String(raw?.js || '').trim();
    if (!js) return { ok: false, error: 'eval needs {"js":"…"} — a JS expression evaluated in the page' };
    if (js.length > MAX_EVAL) return { ok: false, error: `eval too long (${js.length} > ${MAX_EVAL} chars)` };
    step.js = js;
  } else if (action === 'wait') {
    const ms = Math.min(Number(raw?.ms ?? 500) || 500, MAX_WAIT_MS);
    step.ms = Math.max(0, Math.round(ms));
  } else if (action === 'text') {
    // no fields — flags the child to capture document.body.innerText
  } else if (action === 'screenshot') {
    if (raw?.path != null && String(raw.path).trim()) {
      const p = String(raw.path).trim();
      const abs = path.isAbsolute(p) ? p : path.join(root, p);
      const inside = path.resolve(abs).startsWith(path.resolve(root) + path.sep) || path.resolve(abs) === path.resolve(root);
      if (!inside) return { ok: false, error: `screenshot path escapes the project root: ${truncate(p, 80)}` };
      if (!/\.(png|jpe?g)$/i.test(abs)) return { ok: false, error: 'screenshot path must end .png or .jpg' };
      step.path = path.resolve(abs);
    } else {
      const dir = path.join(root, defaultShotDir);
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* child re-tries */ }
      step.path = path.join(dir, `shot-${Date.now()}-${seq + 1}.png`);
    }
    if (raw?.fullPage != null) step.fullPage = raw.fullPage === true || raw.fullPage === 'true';
  }
  return { ok: true, step };
}

/** Validate the whole call: either {"steps":[…]} or the direct convenience
 *  form where the top-level args ARE one step ({"action":"screenshot","url":…}). */
export function parseBrowserCall(args = {}, { root } = {}) {
  const list = Array.isArray(args?.steps) ? args.steps : [args];
  if (!list.length) return { ok: false, error: 'no steps given' };
  if (list.length > MAX_STEPS) return { ok: false, error: `too many steps (${list.length} > ${MAX_STEPS}) — split the call` };
  const steps = [];
  for (let i = 0; i < list.length; i++) {
    const r = parseStep(list[i], { root, seq: i });
    if (!r.ok) return { ok: false, error: `step ${i + 1}: ${r.error}` };
    steps.push(r.step);
  }
  let w = Number(args?.width ?? 1280), h = Number(args?.height ?? 720);
  w = Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(w) || 1280));
  h = Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(h) || 720));
  return { ok: true, steps, viewport: { width: w, height: h } };
}

/** riskyWhen helper: any page-interaction step makes the call risky. */
export function hasActStep(args = {}) {
  const list = Array.isArray(args?.steps) ? args.steps : [args];
  return list.some((s) => ACT_ACTIONS.has(String(s?.action || '').toLowerCase()));
}

/** The child driver. Resolves the driver from the PROJECT's node_modules
 *  (createRequire against the project package.json), runs the steps, prints
 *  one JSON line. Playwright and puppeteer share enough surface (newPage,
 *  goto, click, type, evaluate, screenshot, title) for one small adapter. */
export function driverScript(commandJson) {
  const cmd = JSON.stringify(commandJson);
  return `(async () => {
  const cmd = JSON.parse(process.argv[process.argv.length - 1] || '{}'); // last arg — node -e eats the -- separator
  const { createRequire } = require('module');
  const req = createRequire(require('path').join(process.cwd(), 'package.json'));
  const out = { ok: false, steps: [], shots: [] };
  let browser = null;
  const die = (e) => { process.stdout.write(JSON.stringify({ ...out, ok: false, error: String(e && e.message || e) })); };
  try {
    let page;
    if (cmd.driver === 'playwright') {
      const pw = req('playwright');
      browser = await pw.chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: cmd.viewport });
    } else {
      const pu = req('puppeteer');
      browser = await pu.launch({ headless: true });
      page = await browser.newPage();
      try { await page.setViewport(cmd.viewport); } catch {}
    }
    for (let i = 0; i < cmd.steps.length; i++) {
      const s = cmd.steps[i];
      try {
        if (s.action === 'open') { await page.goto(s.url, { waitUntil: 'load', timeout: 30000 }); out.url = page.url(); }
        else if (s.action === 'click') { await page.click(s.selector, { timeout: 8000 }); }
        else if (s.action === 'type') { await page.type(s.selector, s.text, { delay: 10 }); }
        else if (s.action === 'eval') { const v = await page.evaluate(s.js); out.lastEval = typeof v === 'string' ? v.slice(0, 500) : v; }
        else if (s.action === 'wait') { await new Promise((r) => setTimeout(r, s.ms)); }
        else if (s.action === 'text') { out.text = await page.evaluate('document.body ? document.body.innerText : ""'); }
        else if (s.action === 'screenshot') {
          await page.screenshot({ path: s.path, fullPage: !!s.fullPage });
          out.shots.push(s.path);
        }
        out.steps.push({ i, action: s.action, ok: true });
      } catch (e) {
        out.steps.push({ i, action: s.action, ok: false, error: String(e && e.message || e).split('\\n')[0] });
        die(new Error('step ' + (i + 1) + ' (' + s.action + ') failed: ' + out.steps[out.steps.length - 1].error));
        try { await browser.close(); } catch {}
        return;
      }
    }
    try { out.title = await page.title(); } catch {}
    if (!out.url) { try { out.url = page.url(); } catch {} }
    out.ok = true;
    process.stdout.write(JSON.stringify(out));
  } catch (e) { die(e); }
  finally { try { await browser.close(); } catch {} }
})().catch((e) => { process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) })); });`;
}

/** Probe which driver the PROJECT provides. Injectable for tests. */
export function probeDriver(root, probe = null) {
  if (probe) return probe(root);
  for (const mod of ['playwright', 'puppeteer']) {
    try {
      const r = spawnSync(process.execPath, ['-e', `try{require.resolve(${JSON.stringify(mod)});process.stdout.write('1')}catch{}`], {
        cwd: root, encoding: 'utf8', timeout: 10000,
      });
      if (r.status === 0 && String(r.stdout).trim() === '1') return mod;
    } catch { /* probe failed — treat as absent */ }
  }
  return null;
}

/** Run one validated browser call. Injectable runner keeps tests offline. */
export async function runBrowserCall(args = {}, { root = process.cwd(), probe = null, runner = null, clock = Date } = {}) {
  const parsed = parseBrowserCall(args, { root });
  if (!parsed.ok) return `ERROR: ${parsed.error}`;
  const driver = probeDriver(root, probe);
  if (!driver) {
    return 'ERROR: no browser driver in this repo (node_modules/playwright and puppeteer both missing) — Buddy never bundles browsers; install one in the project (npm i -D playwright && npx playwright install chromium) and retry, or configure a browser MCP server in .buddy and drive it through the mcp tool';
  }
  const t0 = clock.now();
  const script = driverScript({ driver, steps: parsed.steps, viewport: parsed.viewport });
  const fn = runner || ((s, o) => {
    const r = spawnSync(process.execPath, ['-e', s, '--', JSON.stringify(o.command)], { cwd: o.root, timeout: o.timeoutMs, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  });
  const r = fn(script, { root, command: { driver, steps: parsed.steps, viewport: parsed.viewport }, timeoutMs: CHILD_TIMEOUT_MS });
  let res = null;
  try { res = JSON.parse(String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || 'null'); } catch { /* below */ }
  if (!res) {
    return `ERROR: the browser driver produced no result${r.stderr ? ` — ${truncate(String(r.stderr), 300)}` : ''}`;
  }
  const ms = clock.now() - t0;
  if (!res.ok) {
    const failed = (res.steps || []).find((s) => s.ok === false);
    return `ERROR: ${truncate(String(res.error || 'browser run failed'), 400)}${failed ? `\n(steps completed before failure: ${failed.i})` : ''}`;
  }
  const done = (res.steps || []).filter((s) => s.ok).length;
  const lines = [`browser ok — ${truncate(String(res.title || '(no title)'), 80)} — ${truncate(String(res.url || ''), 120)} (${done}/${parsed.steps.length} steps, ${ms}ms, driver: ${driver})`];
  for (const shot of res.shots || []) {
    const rel = path.relative(root, shot);
    let kb = '?';
    try { kb = Math.max(1, Math.round(fs.statSync(shot).size / 1024)); } catch { /* gone? */ }
    lines.push(`  📸 ${rel} (${kb}KB) — @mention this path to attach it to the conversation (vision)`);
  }
  if (res.text) lines.push(truncate(String(res.text).replace(/\s+/g, ' ').trim(), MAX_TEXT));
  if (res.lastEval != null) lines.push(`eval → ${truncate(typeof res.lastEval === 'string' ? res.lastEval : JSON.stringify(res.lastEval), 200)}`);
  return lines.join('\n');
}

export function createBrowserTool({ root } = {}) {
  return {
    name: 'browser',
    description:
      'Drive a real headless browser — one call, one ordered list of steps: {"steps":[{"action":"open","url":"https://…"},{"action":"screenshot"},{"action":"text"}]}. Actions: open (SSRF-guarded http/https; file:// for local pages), click, type, eval (page JS), wait, text, screenshot (saved INSIDE the project — default .buddy/browser/ — @mention the reported path to attach the PNG as a vision payload). The driver is THE PROJECT\'S OWN playwright or puppeteer (never bundled — loads only in a spawned child); absent = honest refusal naming npm i -D playwright. click/type/eval ask for approval (they act on the page); open/screenshot/text/wait are gate-free. Never type secrets into pages — args land in the transcript.',
    args: '{"steps":[{"action":"open","url":"https://example.com"},{"action":"screenshot"},{"action":"text"}],"width":1280,"height":720} — or the direct form {"action":"screenshot","url":"file:///path/to/page.html"}',
    riskyWhen: (a) => hasActStep(a),
    render: (a) => {
      const list = Array.isArray(a?.steps) ? a.steps : [a || {}];
      const acts = list.map((s) => String(s?.action || '?')).join('+');
      const u = list.find((s) => s?.url)?.url || '';
      return `browser ${truncate(acts, 40)}${u ? ` ${truncate(String(u), 60)}` : ''}`;
    },
    run: async (args) => runBrowserCall(args, { root }),
  };
}
