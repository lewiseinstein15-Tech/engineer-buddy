#!/usr/bin/env node
// v0.63.0 DRILL — the cut-off reply. The v0.62 live task test died twice on
// `fs_write test/store.test.js`: a 4.4KB payload at the default 1500-token
// budget was cut mid-JSON by the relay (finish_reason "length" — which no
// code path read), the repair asked AGAIN at the same budget, the model
// rewrote the same big payload, was cut at the same byte, and the turn died
// with the todo stalled. Five frames, every leg through the REAL createChat /
// runAgent over the REAL kilo gateway on REAL HTTP to a loopback relay whose
// per-request WITNESS LOG is written by the server itself:
//   1  the live failure replayed: the relay cuts a big fs_write (finish
//      'length') → the repair rides a DOUBLED budget (the SERVER's witness
//      logs max_tokens 3000 on the wire) carrying the split teaching → the
//      model splits (fs_write + fs_append) → the file really lands on disk.
//   2  an always-cutting relay: three requests (1500, 3000, 3000), the turn
//      errors, and the error event NAMES the cut-off instead of blaming
//      formatting.
//   3  a SILENT relay (cut body, finish 'stop' — the wire does not confess):
//      the shape heuristic still diagnoses it, the boost still fires.
//   4  a generic sneeze keeps the historical contract: ONE repair at the
//      SAME budget with the GENERIC message — no boost for non-cutoffs.
//   5  the one-shot agent ladder over the same wire: 1200 → 2400, finish.
// The gate re-reads every frame from disk (the v0.58 lesson: evidence must
// prove it ran) and checks groundtruth.json's must_contain per frame — the
// witness files themselves are copied into the frames dir as raw evidence.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayRouter } from '../src/brain/router.js';
import { createKiloGateway } from '../src/brain/gateways/kilo.js';
import { createChat } from '../src/agent/chat.js';
import { runAgent } from '../src/agent/agent.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DRILL_DIR = path.join(REPO, 'scripts', 'v63-frames');
const framesDir = path.join(DRILL_DIR, 'frames');
fs.rmSync(DRILL_DIR, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v63-drill-'));
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

// ── the loopback relay: an OpenAI-shaped HTTP server that SCRIPTS replies
// and WITNESSES every request's max_tokens + tail of the conversation.
// The client's word is not evidence — the server logs what actually arrived.
function makeRelay(witnessPath) {
  const script = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/v1\/models$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-coder:free' }] }));
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
        const entry = script.length
          ? script.shift()
          : { content: '{"tool":"say","message":"(relay script exhausted)"}', finish: 'stop' };
        // THE WITNESS ROW — written by the SERVER, before the response.
        fs.appendFileSync(
          witnessPath,
          JSON.stringify({
            at: Date.now(),
            max_tokens: parsed.max_tokens ?? null,
            model: parsed.model ?? null,
            n_messages: msgs.length,
            last_role: last.role ?? null,
            last_head: String(last.content ?? '').slice(0, 260),
            last_mentions_split: /fs_append/.test(String(last.content ?? '')),
          }) + '\n'
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'mock-coder:free',
            choices: [{ message: { role: 'assistant', content: entry.content }, finish_reason: entry.finish ?? 'stop' }],
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

// A REAL GatewayRouter whose ONLY gateway is the REAL kilo gateway pointed at
// the loopback relay — the same wire path a live session takes.
async function realRouter(relay) {
  const gw = createKiloGateway(
    { baseUrl: relay.baseUrl, models: 'auto', apiKey: 'anonymous', preferredModels: ['mock-coder:free'] },
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

// The live shape: a fs_write whose content string never closes (a 4.4KB
// payload at 1500 tokens dies mid-string on a real tokenizer). Built big
// enough that the 4000-char slice REALLY cuts — the JSON must be left open,
// exactly the live failure.
const cutContent = JSON.stringify({
  tool: 'fs_write',
  args: { path: 'test/store.test.js', content: 'line one\nline two\n'.repeat(300) + 'const x = { a: 1, b: [2, 3], c: { d: 4 }' },
}).slice(0, 4000);

const events = [];
const lastUserHead = (rows) => (rows.length ? rows[rows.length - 1].last_head : '');

// ── frame 1: the live failure replayed — doubled-budget repair, split write ─
{
  console.log('frame 1: the live failure replayed — the relay cuts, the ladder boosts to 3000 and teaches the split, the file lands');
  const witness = path.join(tmp, 'w1.jsonl');
  const relay = makeRelay(witness);
  const { baseUrl } = await relay.start();
  relay.script.push(
    { content: cutContent, finish: 'length' }, // the cut fs_write (what kilo really sent)
    { content: '{"tool":"fs_write","args":{"path":"part1.txt","content":"first part"},"why":"split the write"}', finish: 'stop' },
    { content: '{"tool":"fs_append","args":{"path":"part1.txt","content":"second part"},"why":"finish the split file"}', finish: 'stop' },
    { content: '{"tool":"say","message":"wrote it in two parts"}', finish: 'stop' }
  );
  const ws = fs.mkdtempSync(path.join(tmp, 'ws1-'));
  const { tools, harness } = makeBuddy(ws);
  const chat = createChat({ router: await realRouter(relay), tools, harness, root: ws, onEvent: (e) => events.push(e) });
  const out = await chat.turn('build the store test file');
  relay.stop();
  const rows = readWitness(witness);
  const file = fs.readFileSync(path.join(ws, 'part1.txt'), 'utf8');
  frame('01-cut-recovered.json', {
    said: out.said,
    error: out.error ?? null,
    file_content: file,
    witness: rows,
    witness_file: '01-witness.jsonl',
    note: 'req1 = the cut fs_write (finish length); req2 = the repair — the SERVER saw max_tokens 3000 and the split teaching; req3+ = the split steps at the base budget',
  });
  fs.copyFileSync(witness, path.join(framesDir, '01-witness.jsonl'));
  step(out.said === 'wrote it in two parts' && !out.error, 'turn completed: the split write carried the turn');
  step(rows.length === 4, `relay served 4 requests (${rows.length})`);
  step(rows[0].max_tokens === 1500, 'req1 rode the base budget 1500 (the cut)');
  step(rows[1].max_tokens === 3000, `req2 repair rode the DOUBLED budget on the wire (server saw ${rows[1].max_tokens})`);
  step(/CUT OFF by the output token limit/.test(lastUserHead([rows[1]])) && rows[1].last_mentions_split === true, 'req2 carried the split teaching (fs_write + fs_append), not a formatting blame');
  step(rows[2].max_tokens === 1500 && rows[3].max_tokens === 1500, 'req3/req4 back at the base budget — the boost was the repair, not the session');
  step(file === 'first part\nsecond part', 'the file REALLY landed on disk: fs_write + fs_append bytes intact');
  step(!events.some((e) => e.type === 'error'), 'zero error events');
}

// ── frame 2: an always-cutting relay — three asks, named failure ────────────
{
  console.log('frame 2: an always-cutting relay — 1500 → 3000 → 3000, the error NAMES the cut-off');
  const witness = path.join(tmp, 'w2.jsonl');
  const relay = makeRelay(witness);
  await relay.start();
  relay.script.push(
    { content: cutContent, finish: 'length' },
    { content: cutContent.replace('store', 'store2'), finish: 'length' },
    { content: cutContent.replace('store', 'store3'), finish: 'length' }
  );
  const ws = fs.mkdtempSync(path.join(tmp, 'ws2-'));
  const { tools, harness } = makeBuddy(ws);
  const evs = [];
  const chat = createChat({ router: await realRouter(relay), tools, harness, root: ws, onEvent: (e) => evs.push(e) });
  const out = await chat.turn('go');
  relay.stop();
  const rows = readWitness(witness);
  const errText = evs.find((e) => e.type === 'error')?.text || '';
  frame('02-always-cut.json', {
    said: out.said,
    error: out.error ?? null,
    error_event: errText,
    witness: rows,
    witness_file: '02-witness.jsonl',
    note: 'three cuts: the ladder climbed both gears (1500 → 3000 → 3000) and still died — but the diagnosis names the token-limit cut and teaches the split',
  });
  fs.copyFileSync(witness, path.join(framesDir, '02-witness.jsonl'));
  step(out.said === null && out.error === true, 'the turn ended honestly in error');
  step(rows.length === 3 && rows[1].max_tokens === 3000 && rows[2].max_tokens === 3000, `three brain calls at 1500/3000/3000 (server saw ${rows.map((r) => r.max_tokens).join(', ')})`);
  step(/cut off by the output token limit/.test(errText), 'the error event NAMES the cut-off (not a formatting blame)');
  step(/fs_write \+ fs_append/.test(errText), 'the error event teaches the split');
  step(/First: \{"tool":"fs_write"/.test(errText), 'the error event shows the ORIGINAL attempt (the tool call the budget ate)');
}

// ── frame 3: a silent relay — the wire does not confess, the shape speaks ───
{
  console.log('frame 3: a SILENT relay (finish stop on a cut body) — the shape heuristic still diagnoses it');
  const witness = path.join(tmp, 'w3.jsonl');
  const relay = makeRelay(witness);
  await relay.start();
  relay.script.push(
    { content: cutContent, finish: 'stop' }, // a lying/naive relay: no length finish
    { content: '{"tool":"say","message":"recovered on the heuristic"}', finish: 'stop' }
  );
  const ws = fs.mkdtempSync(path.join(tmp, 'ws3-'));
  const { tools, harness } = makeBuddy(ws);
  const chat = createChat({ router: await realRouter(relay), tools, harness, root: ws });
  const out = await chat.turn('go');
  relay.stop();
  const rows = readWitness(witness);
  frame('03-silent-cut.json', {
    said: out.said,
    error: out.error ?? null,
    witness: rows,
    witness_file: '03-witness.jsonl',
    note: 'the relay cut the body but reported finish stop — no wire witness. The unbalanced shape (a tool call that ran off the end of its string) still diagnosed it; the boost still fired',
  });
  fs.copyFileSync(witness, path.join(framesDir, '03-witness.jsonl'));
  step(out.said === 'recovered on the heuristic' && !out.error, 'recovered: the heuristic carried the ladder');
  step(rows.length === 2 && rows[0].max_tokens === 1500 && rows[1].max_tokens === 3000, `silent relay still got the boosted repair (server saw ${rows.map((r) => r.max_tokens).join(', ')})`);
  step(/CUT OFF by the output token limit/.test(lastUserHead([rows[1]])), 'the split teaching rode the heuristic path too');
}

// ── frame 4: a generic sneeze keeps the historical contract ─────────────────
{
  console.log('frame 4: a generic sneeze — ONE repair at the SAME budget, the GENERIC message');
  const witness = path.join(tmp, 'w4.jsonl');
  const relay = makeRelay(witness);
  await relay.start();
  relay.script.push(
    { content: 'I think we should look at the files first.', finish: 'stop' },
    { content: '{"tool":"say","message":"repaired the old way"}', finish: 'stop' }
  );
  const ws = fs.mkdtempSync(path.join(tmp, 'ws4-'));
  const { tools, harness } = makeBuddy(ws);
  const chat = createChat({ router: await realRouter(relay), tools, harness, root: ws });
  const out = await chat.turn('go');
  relay.stop();
  const rows = readWitness(witness);
  frame('04-generic-contract.json', {
    said: out.said,
    error: out.error ?? null,
    witness: rows,
    witness_file: '04-witness.jsonl',
    note: 'prose sneeze (finish stop, balanced nothing): one repair, same 1500 budget, the generic ask — the boost is for cut-offs only',
  });
  fs.copyFileSync(witness, path.join(framesDir, '04-witness.jsonl'));
  step(out.said === 'repaired the old way', 'recovered on the first repair');
  step(rows.length === 2 && rows[0].max_tokens === 1500 && rows[1].max_tokens === 1500, `both calls at the base 1500 (server saw ${rows.map((r) => r.max_tokens).join(', ')})`);
  step(/was not a single JSON object/.test(lastUserHead([rows[1]])) && !/CUT OFF/.test(lastUserHead([rows[1]])), 'the GENERIC teaching rode the generic path — no split lesson wasted on a sneeze');
}

// ── frame 5: the one-shot agent ladder over the same wire ───────────────────
{
  console.log('frame 5: the one-shot agent — 1200 → 2400, finished after the boosted repair');
  const witness = path.join(tmp, 'w5.jsonl');
  const relay = makeRelay(witness);
  await relay.start();
  relay.script.push(
    { content: cutContent, finish: 'length' },
    { content: '{"tool":"finish","result":"finished after the boosted repair"}', finish: 'stop' }
  );
  const ws = fs.mkdtempSync(path.join(tmp, 'ws5-'));
  const { tools } = makeBuddy(ws);
  const router = await realRouter(relay);
  const out = await runAgent({ router, tools, systemPrompt: 'drill', messages: [{ role: 'user', content: 'go' }], maxSteps: 4, maxTokens: 1200 });
  relay.stop();
  const rows = readWitness(witness);
  frame('05-agent-ladder.json', {
    finished: out.finished,
    result: out.result ?? null,
    witness: rows,
    witness_file: '05-witness.jsonl',
    note: 'runAgent (the one-shot/subagent loop) climbed the same ladder on the real wire: base 1200, repair 2400, finish',
  });
  fs.copyFileSync(witness, path.join(framesDir, '05-witness.jsonl'));
  step(out.finished === true && /boosted repair/.test(String(out.result)), 'the one-shot finished after the boosted repair');
  step(rows.length === 2 && rows[0].max_tokens === 1200 && rows[1].max_tokens === 2400, `agent calls at 1200/2400 (server saw ${rows.map((r) => r.max_tokens).join(', ')})`);
  step(/CUT OFF by the output token limit/.test(lastUserHead([rows[1]])), 'the agent repair carried the split teaching');
}

// ── gate: re-read every frame from disk ─────────────────────────────────────
const groundtruth = {
  wave: 'v0.63.0 — the cut-off reply (the v0.62 live-test lesson)',
  gate: 're-reads every frame from disk; every must_contain string must appear in the frame file',
  frames: [
    { file: '01-cut-recovered.json', must_contain: ['"max_tokens": 3000', 'CUT OFF by the output token limit', '"last_mentions_split": true', '"first part\\nsecond part"', 'wrote it in two parts'] },
    { file: '02-always-cut.json', must_contain: ['"max_tokens": 3000', 'cut off by the output token limit', 'fs_write + fs_append', 'First: {\\"tool\\":\\"fs_write\\"', '"error": true'] },
    { file: '03-silent-cut.json', must_contain: ['"max_tokens": 3000', 'CUT OFF by the output token limit', 'recovered on the heuristic'] },
    { file: '04-generic-contract.json', must_contain: ['"max_tokens": 1500', 'was not a single JSON object', 'repaired the old way'] },
    { file: '05-agent-ladder.json', must_contain: ['"max_tokens": 2400', 'CUT OFF by the output token limit', 'finished after the boosted repair'] },
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
console.log(`\nDRILL v0.63: ${passedCount}/${total} checks PASS`);
if (failures) {
  console.log('DRILL: FAIL');
  process.exit(1);
}
console.log('DRILL: PASS — the gate re-read the evidence and it holds.');
process.exit(0);
