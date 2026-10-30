#!/usr/bin/env node
// v0.64.0 DRILL — the catalog is the enemy. The 2026-10-31 live-wire probe
// settled the "still not fixed / the type box is blinking" report: the relay
// HONORS max_tokens (the v0.63.0 boost was never the broken leg) — the enemy
// was the MODEL CHOICE. kilo's old pickModel preferred reasoning-flavored free
// models, which stream invisible delta.reasoning_content, burn the ENTIRE
// output budget on it and answer EMPTY content after ~135 seconds of total
// silence (probe: nemotron-3.5-super-vl:free — 5063 reasoning chars, zero
// content, finish 'length', ctok 1500). From the user's chair: the type box
// blinks for minutes, then the turn dies on failover churn. Six frames, every
// leg through the REAL createChat / REAL kilo gateway on REAL HTTP to a
// loopback relay whose per-request WITNESS LOG is written by the server:
//   1  the silent stall replayed: the preferred model answers reasoning-only
//      (finish 'length', zero content) → the SAME call rotates to the next
//      candidate → the reply lands; the NEXT call never asks the bad model
//      again (the 10-minute blacklist, witnessed by the server).
//   2  the inline HTTP-200 error envelope ({"error":{code:502}} inside a 200,
//      witnessed live) → rotation, not a dead turn.
//   3  buffered empty content → rotation, and the diagnosis is honest.
//   4  streaming reasoning-only on the SSE path (delta.reasoning_content) —
//      the wire reader counts reasoning chars the old code never saw.
//   5  every candidate bad → bounded death (exactly MAX_MODEL_ATTEMPTS per
//      router round), the error names the burned budget, no infinite churn.
//   6  regression: the v0.63.0 cut-reply ladder still works on the new wire —
//      cut fs_write → doubled-budget repair with the split teaching → the
//      file lands (with rotation machinery present and un-triggered).
// The gate re-reads every frame from disk and checks groundtruth.json's
// must_contain per frame; witness files are copied in as raw evidence.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayRouter } from '../src/brain/router.js';
import { createKiloGateway } from '../src/brain/gateways/kilo.js';
import { createChat } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DRILL_DIR = path.join(REPO, 'scripts', 'v64-frames');
const framesDir = path.join(DRILL_DIR, 'frames');
fs.rmSync(DRILL_DIR, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v64-drill-'));
let failures = 0;
const step = (cond, msg) => { console.log(`   ${cond ? '✔' : '✗'} ${msg}`); if (!cond) failures += 1; };
const frame = (name, obj) => {
  const f = path.join(framesDir, name);
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
  return f;
};
const readWitness = (p) =>
  fs.existsSync(p)
    ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } })
    : [];

// ONE catalog for the whole drill — the gateway's model cache (1h TTL) is
// module-level, so every relay in this process must agree on the ids.
const CATALOG = ['mock-reasoning:free', 'mock-coder:free', 'mock-mini:free'];
const OK_REPLY = '{"tool":"say","message":"the real answer"}';

// ── the loopback relay: an OpenAI-shaped HTTP server whose replies are
// SCRIPTED PER MODEL and whose WITNESS LOG is written by the server itself
// (model, max_tokens, conversation tail) before the response goes out.
function makeRelay(witnessPath) {
  const script = []; // { model, content, finish, kind:'sse'|'json', reasoning }
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/v1\/models$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: CATALOG.map((id) => ({ id })) }));
      return;
    }
    if (req.method === 'POST' && /\/v1\/chat\/completions$/.test(req.url)) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* junk body → empty */ }
        const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
        const last = msgs[msgs.length - 1] || {};
        const model = parsed.model ?? null;
        const idx = script.findIndex((s) => s.model === model);
        const entry = idx !== -1
          ? script.splice(idx, 1)[0]
          : { content: '{"tool":"say","message":"(relay script exhausted)"}', finish: 'stop', kind: 'json' };
        // THE WITNESS ROW — written by the SERVER, before the response.
        fs.appendFileSync(
          witnessPath,
          JSON.stringify({
            at: Date.now(),
            max_tokens: parsed.max_tokens ?? null,
            model,
            n_messages: msgs.length,
            last_role: last.role ?? null,
            last_head: String(last.content ?? '').slice(0, 200),
            last_mentions_split: /fs_append/.test(String(last.content ?? '')),
          }) + '\n'
        );
        if (entry.kind === 'sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const frames = [];
          if (entry.reasoning) {
            frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: entry.reasoning } }] })}\n\n`);
          }
          if (entry.content) {
            frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: entry.content } }] })}\n\n`);
          }
          frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: entry.finish ?? 'stop' }] })}\n\n`);
          frames.push('data: [DONE]\n\n');
          res.end(frames.join(''));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (entry.envelope === 'error') {
          // the live-witnessed shape: HTTP 200 carrying the provider's error
          res.end(JSON.stringify({ error: { message: 'Inference connection error while making inference request', code: 502, metadata: { error_type: 'provider_unavailable' } } }));
          return;
        }
        res.end(
          JSON.stringify({
            model,
            choices: [{ message: { role: 'assistant', content: entry.content ?? '' }, finish_reason: entry.finish ?? 'stop' }],
            usage: { prompt_tokens: 11, completion_tokens: 40, total_tokens: 51 },
          })
        );
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return {
    script,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      this.baseUrl = `http://127.0.0.1:${server.address().port}`;
      return this.baseUrl;
    },
    stop() {
      try { server.close(); } catch { /* best effort */ }
    },
  };
}

function realRouter(relay, extraCfg = {}) {
  const gw = createKiloGateway(
    { baseUrl: relay.baseUrl, models: 'auto', apiKey: 'anonymous', ...extraCfg },
    { chatMs: 15000, httpMs: 5000 }
  );
  return new GatewayRouter(new Map([['kilo', gw]]), { gatewayOrder: ['kilo'] });
}

function makeBuddy(ws) {
  ensureHarness(ws);
  const scope = new LocalScope(ws);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(ws));
  return { tools, harness };
}

const events = [];
const okSse = (model, content, extra = {}) => ({ model, kind: 'sse', content, finish: 'stop', ...extra });

// ── frame 1: the silent stall replayed — rotation + the blacklist holds ─────
{
  console.log('frame 1: reasoning-only stall → SAME-call rotation → the blacklist holds on the next call');
  const witness = path.join(tmp, 'w1.jsonl');
  const relay = makeRelay(witness);
  const { baseUrl } = await relay.start();
  relay.script.push(
    { model: 'mock-reasoning:free', kind: 'sse', content: '', finish: 'length', reasoning: 'x'.repeat(5000) },
    okSse('mock-coder:free', OK_REPLY),
    okSse('mock-coder:free', OK_REPLY)
  );
  const ws = fs.mkdtempSync(path.join(tmp, 'ws1-'));
  const { tools, harness } = makeBuddy(ws);
  const chat = createChat({
    router: realRouter(relay, { preferredModels: ['mock-reasoning:free'] }), // the operator's catalog preference, as the live config had
    tools, harness, root: ws,
    onEvent: (e) => events.push(e),
    onStream: () => {}, // the TUI listens → the streaming (SSE) path runs
  });
  const out1 = await chat.turn('do the thing');
  const out2 = await chat.turn('and again');
  relay.stop();
  const rows = readWitness(witness);
  frame('01-rotation-blacklist.json', {
    said: [out1.said, out2.said],
    error: [out1.error ?? null, out2.error ?? null],
    witness: rows,
    witness_file: '01-witness.jsonl',
    note: 'req1 = the preferred reasoning model: finish length, ZERO content (the budget went to invisible reasoning tokens); req2 = the SAME call rotated to the plain codeish model and answered; req3 = the NEXT call asked the good model FIRST — the 10-minute blacklist held',
  });
  fs.copyFileSync(witness, path.join(framesDir, '01-witness.jsonl'));
  step(out1.said === 'the real answer' && !out1.error, 'turn 1 completed despite the reasoning-only stall (rotation carried it)');
  step(out2.said === 'the real answer' && !out2.error, 'turn 2 completed');
  step(rows.length === 3, `relay served exactly 3 requests (${rows.length})`);
  step(rows[0].model === 'mock-reasoning:free', 'req1 asked the operator-preferred model first');
  step(rows[1].model === 'mock-coder:free', 'req2 rotated within the SAME call to the plain candidate');
  step(rows[2].model === 'mock-coder:free', 'req3 never asked the blacklisted model again (server-witnessed)');
}

// ── frame 2: the inline HTTP-200 error envelope → rotation ──────────────────
{
  console.log('frame 2: inline HTTP-200 error envelope (live-witnessed shape) → rotation, not a dead turn');
  const witness = path.join(tmp, 'w2.jsonl');
  const relay = makeRelay(witness);
  await relay.start();
  relay.script.push(
    { model: 'mock-coder:free', kind: 'json', envelope: 'error' },
    okSse('mock-mini:free', OK_REPLY)
  );
  const ws = fs.mkdtempSync(path.join(tmp, 'ws2-'));
  const { tools, harness } = makeBuddy(ws);
  const chat = createChat({ router: realRouter(relay), tools, harness, root: ws, onEvent: (e) => events.push(e), onStream: () => {} });
  const out = await chat.turn('go');
  relay.stop();
  const rows = readWitness(witness);
  frame('02-inline-error-rotation.json', {
    said: out.said,
    error: out.error ?? null,
    witness: rows,
    witness_file: '02-witness.jsonl',
    note: 'req1 = HTTP 200 with {"error":{code:502}} and no choices (provider_unavailable, witnessed live 2026-10-31); req2 = the SAME call rotated to the next plain candidate',
  });
  fs.copyFileSync(witness, path.join(framesDir, '02-witness.jsonl'));
  step(out.said === 'the real answer' && !out.error, 'the turn survived the provider error');
  step(rows[0].model === 'mock-coder:free' && rows[1].model === 'mock-mini:free', `rotation ${rows.map((r) => r.model).join(' → ')}`);
}

// ── frame 3: buffered empty content → rotation, honest diagnosis ────────────
{
  console.log('frame 3: buffered empty content → rotation (no reasoning char excuse)');
  const witness = path.join(tmp, 'w3.jsonl');
  const relay = makeRelay(witness);
  await relay.start();
  relay.script.push(
    { model: 'mock-coder:free', kind: 'json', content: '', finish: 'stop' },
    okSse('mock-mini:free', OK_REPLY)
  );
  const ws = fs.mkdtempSync(path.join(tmp, 'ws3-'));
  const { tools, harness } = makeBuddy(ws);
  const chat = createChat({ router: realRouter(relay), tools, harness, root: ws, onEvent: (e) => events.push(e), onStream: () => {} });
  const out = await chat.turn('go');
  relay.stop();
  const rows = readWitness(witness);
  frame('03-buffered-empty.json', {
    said: out.said,
    error: out.error ?? null,
    witness: rows,
    witness_file: '03-witness.jsonl',
    note: 'req1 = buffered JSON with content:"" (finish stop); req2 = rotation carried the turn',
  });
  fs.copyFileSync(witness, path.join(framesDir, '03-witness.jsonl'));
  step(out.said === 'the real answer' && !out.error, 'the turn survived the empty content');
  step(rows[0].model === 'mock-coder:free' && rows[1].model === 'mock-mini:free', `rotation ${rows.map((r) => r.model).join(' → ')}`);
}

// ── frame 4: streaming reasoning-only on the SSE wire ───────────────────────
{
  console.log('frame 4: SSE delta.reasoning_content — the wire reader counts what the old code never saw');
  const witness = path.join(tmp, 'w4.jsonl');
  const relay = makeRelay(witness);
  await relay.start();
  relay.script.push(
    { model: 'mock-coder:free', kind: 'sse', content: '', finish: 'length', reasoning: 'deep but invisible thoughts' },
    okSse('mock-mini:free', OK_REPLY)
  );
  const ws = fs.mkdtempSync(path.join(tmp, 'ws4-'));
  const { tools, harness } = makeBuddy(ws);
  const chat = createChat({ router: realRouter(relay), tools, harness, root: ws, onEvent: (e) => events.push(e), onStream: () => {} });
  const out = await chat.turn('go');
  relay.stop();
  const rows = readWitness(witness);
  frame('04-sse-reasoning.json', {
    said: out.said,
    error: out.error ?? null,
    witness: rows,
    witness_file: '04-witness.jsonl',
    note: 'req1 streamed ONLY delta.reasoning_content and finished length with no content — the nemotron shape; the reasoning chars were counted (unit-pinned) and the model rotated',
  });
  fs.copyFileSync(witness, path.join(framesDir, '04-witness.jsonl'));
  step(out.said === 'the real answer' && !out.error, 'the turn survived the streaming reasoning-only reply');
  step(rows[0].model === 'mock-coder:free' && rows[1].model === 'mock-mini:free', `rotation ${rows.map((r) => r.model).join(' → ')}`);
}

// ── frame 5: every candidate bad → bounded death with the honest diagnosis ──
{
  console.log('frame 5: every model burns the budget on reasoning — bounded death, the diagnosis NAMES it');
  const witness = path.join(tmp, 'w5.jsonl');
  const relay = makeRelay(witness);
  await relay.start();
  for (let i = 0; i < 8; i++) {
    relay.script.push({ model: 'mock-coder:free', kind: 'sse', content: '', finish: 'length', reasoning: 'x'.repeat(3000) });
    relay.script.push({ model: 'mock-mini:free', kind: 'sse', content: '', finish: 'length', reasoning: 'x'.repeat(3000) });
    relay.script.push({ model: 'mock-reasoning:free', kind: 'sse', content: '', finish: 'length', reasoning: 'x'.repeat(3000) });
  }
  const ws = fs.mkdtempSync(path.join(tmp, 'ws5-'));
  const { tools, harness } = makeBuddy(ws);
  const evs = [];
  const chat = createChat({ router: realRouter(relay), tools, harness, root: ws, onEvent: (e) => evs.push(e), onStream: () => {} });
  const out = await chat.turn('go');
  relay.stop();
  const rows = readWitness(witness);
  const errText = evs.find((e) => e.type === 'error')?.text || '';
  frame('05-bounded-death.json', {
    said: out.said,
    error: out.error ?? null,
    error_event: errText.slice(0, 400),
    witness: rows,
    witness_file: '05-witness.jsonl',
    note: 'a catalog where EVERY model is a reasoning-only stall: exactly MAX_MODEL_ATTEMPTS (3) model attempts per router round (6 witnessed across 2 rounds), then the honest brain-offline error naming the burned budget',
  });
  fs.copyFileSync(witness, path.join(framesDir, '05-witness.jsonl'));
  step(out.said === null && out.error === true, 'the turn ended honestly in error');
  step(rows.length === 6, `bounded: exactly 6 model attempts witnessed (2 router rounds × 3 candidates), got ${rows.length}`);
  step(/produced NO content.*reasoning tokens/.test(errText), 'the surfaced error names the burned reasoning budget');
}

// ── frame 6: regression — the v0.63.0 ladder still works on the new wire ────
{
  console.log('frame 6: regression — cut fs_write → doubled-budget repair → the split file lands');
  const witness = path.join(tmp, 'w6.jsonl');
  const relay = makeRelay(witness);
  await relay.start();
  const cutContent = JSON.stringify({
    tool: 'fs_write',
    args: { path: 'test/store.test.js', content: 'line one\nline two\n'.repeat(300) + 'const x = { a: 1, b: [2, 3], c: { d: 4 }' },
  }).slice(0, 4000);
  relay.script.push(
    { model: 'mock-coder:free', kind: 'json', content: cutContent, finish: 'length' },
    { model: 'mock-coder:free', kind: 'json', content: '{"tool":"fs_write","args":{"path":"part1.txt","content":"first part"},"why":"split the write"}', finish: 'stop' },
    { model: 'mock-coder:free', kind: 'json', content: '{"tool":"fs_append","args":{"path":"part1.txt","content":"second part"},"why":"finish the split file"}', finish: 'stop' },
    { model: 'mock-coder:free', kind: 'json', content: '{"tool":"say","message":"wrote it in two parts"}', finish: 'stop' }
  );
  const ws = fs.mkdtempSync(path.join(tmp, 'ws6-'));
  const { tools, harness } = makeBuddy(ws);
  const chat = createChat({ router: realRouter(relay), tools, harness, root: ws, onEvent: (e) => events.push(e) });
  const out = await chat.turn('build the store test file');
  relay.stop();
  const rows = readWitness(witness);
  const file = fs.readFileSync(path.join(ws, 'part1.txt'), 'utf8');
  frame('06-v63-ladder-regression.json', {
    said: out.said,
    error: out.error ?? null,
    file_content: file,
    witness: rows,
    witness_file: '06-witness.jsonl',
    note: 'with all the rotation machinery present: a content-producing model answers, the cut is diagnosed, the repair rides 3000 with the split teaching, and the file lands byte-intact',
  });
  fs.copyFileSync(witness, path.join(framesDir, '06-witness.jsonl'));
  step(out.said === 'wrote it in two parts' && !out.error, 'the v63 ladder end-to-end still green');
  step(rows.every((r) => r.model === 'mock-coder:free'), 'no rotation fired — a good model is never disturbed');
  step(rows[0].max_tokens === 1500 && rows[1].max_tokens === 3000, `budgets ${rows.map((r) => r.max_tokens).join(' → ')} (base → doubled repair)`);
  step(rows[1].last_mentions_split === true, 'the repair carried the split teaching');
  step(file === 'first part\nsecond part', 'the file REALLY landed: fs_write + fs_append bytes intact');
}

// ── gate: re-read every frame from disk ─────────────────────────────────────
const groundtruth = {
  wave: 'v0.64.0 — the catalog is the enemy (the blinking type box lesson)',
  gate: 're-reads every frame from disk; every must_contain string must appear in the frame file',
  frames: [
    { file: '01-rotation-blacklist.json', must_contain: ['"model": "mock-reasoning:free"', '"model": "mock-coder:free"', 'the real answer', 'the 10-minute blacklist held'] },
    { file: '02-inline-error-rotation.json', must_contain: ['"model": "mock-coder:free"', '"model": "mock-mini:free"', 'the real answer', 'provider_unavailable'] },
    { file: '03-buffered-empty.json', must_contain: ['"model": "mock-coder:free"', '"model": "mock-mini:free"', 'the real answer'] },
    { file: '04-sse-reasoning.json', must_contain: ['"model": "mock-coder:free"', '"model": "mock-mini:free"', 'the real answer', 'nemotron shape'] },
    { file: '05-bounded-death.json', must_contain: ['"error": true', 'produced NO content', 'reasoning tokens'] },
    { file: '06-v63-ladder-regression.json', must_contain: ['"max_tokens": 3000', '"last_mentions_split": true', '"first part\\nsecond part"', 'wrote it in two parts'] },
  ],
};
fs.writeFileSync(path.join(DRILL_DIR, 'groundtruth.json'), JSON.stringify(groundtruth, null, 2), 'utf8');

let checked = 0, okCount = 0;
console.log('\ngate: re-reading every frame from disk');
for (const f of groundtruth.frames) {
  const p = path.join(framesDir, f.file);
  const body = fs.readFileSync(p, 'utf8');
  for (const needle of f.must_contain) {
    checked += 1;
    if (body.includes(needle)) okCount += 1;
    else { failures += 1; console.log(`   ✗ ${f.file}: missing ${JSON.stringify(needle)}`); }
  }
}
console.log(`gate: ${okCount}/${checked} must_contain checks passed against the on-disk frames`);

fs.rmSync(tmp, { recursive: true, force: true });
const total = 17 + checked;
const passedCount = total - failures;
console.log(`\nDRILL v0.64: ${passedCount}/${total} checks PASS`);
if (failures) {
  console.log('DRILL: FAIL');
  process.exit(1);
}
console.log('DRILL: PASS — the gate re-read the evidence and it holds.');
process.exit(0);
