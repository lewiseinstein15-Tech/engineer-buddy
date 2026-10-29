#!/usr/bin/env node
// mock-gateway.js — a committed zero-dependency loopback mock that speaks the
// OpenAI chat-completions dialect (both URL shapes: /chat/completions and
// /v1/chat/completions) plus kilo's /v1/models discovery. It exists so the
// multi-model routing drill (scripts/v56-drill.mjs) can put TWO gateways on
// camera — one wearing the 'strong' tier, one wearing 'fast' — and let the
// OTHER END witness which one served which step. The v0.55 lesson carried:
// the server's own counters are the honest witness, not a client-side claim.
//
// The mock's "intelligence" is a SCRIPTED sequence of strict-JSON protocol
// replies (declared by the drill, echoed in every evidence frame) — the wire,
// the parsing, the routing decision and the failover are all REAL Buddy code.
//
// Facts, not content (the house discipline, v0.55 carried): /__facts reports
// request COUNTS, paths, models, max_tokens, message SIZES and wall times —
// never message text.
//
//   node mock-gateway.js --port 8181 --label strong --model strong-model --delay 90 --script-file /tmp/strong.json
//
// Endpoints:
//   GET  /v1/models           → { data: [{ id: <model>:free }] }
//   POST /chat/completions    → OpenAI JSON (the next scripted reply)
//   POST /v1/chat/completions → OpenAI JSON (the next scripted reply)
//   GET  /__facts             → the honest witness counters
//   GET  /__reset             → zero everything (between drill frames)
import http from 'node:http';
import fs from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', 8181));
const LABEL = String(arg('label', 'mock'));
const MODEL = String(arg('model', `${LABEL}-model`));
const DELAY = Math.max(0, Number(arg('delay', 0)) || 0);
const scriptFile = arg('script-file', null);
const cursorFile = arg('script-cursor-file', null); // shared global reply index (sequential callers only)

let script = ['{"tool":"say","message":"mock gateway default reply"}'];
if (scriptFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
    if (Array.isArray(parsed) && parsed.length && parsed.every((s) => typeof s === 'string')) script = parsed;
    else { console.error(`[mock ${LABEL}] script file must be a JSON array of strings`); process.exit(1); }
  } catch (e) {
    console.error(`[mock ${LABEL}] cannot read script file: ${e.message}`);
    process.exit(1);
  }
}

const facts = {
  label: LABEL,
  model: MODEL,
  scriptReplies: script.length,
  sharedCursor: Boolean(cursorFile),
  requests: 0,
  byPath: {},
  maxTokensSeen: [],
  msgCharsSeen: [],
  delayMsTotal: 0,
  startedAt: new Date().toISOString(),
  log: [], // { n, path, model, maxTokens, msgChars, at } — sizes and shapes, never text
};

// Script index: local counter by default; with --script-cursor-file the two
// mocks share ONE global reply index so a scripted STEP always means the
// same reply no matter which tier served it (sequential callers only — the
// Buddy loop never has two chat calls in flight). Cursor 0-based.
function nextScriptIndex() {
  if (!cursorFile) return facts.requests; // incremented before this call
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const cur = Number(fs.readFileSync(cursorFile, 'utf8').trim()) || 0;
      fs.writeFileSync(cursorFile, String(cur + 1));
      return cur;
    } catch {
      /* torn read — retry */
    }
  }
  return 0;
}

function reply(res, code, body, type = 'application/json') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const pathOnly = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (pathOnly === '/__facts' || pathOnly === '/__reset')) {
    if (pathOnly === '/__reset') {
      facts.requests = 0;
      facts.byPath = {};
      facts.maxTokensSeen = [];
      facts.msgCharsSeen = [];
      facts.delayMsTotal = 0;
      facts.log = [];
      if (cursorFile) fs.writeFileSync(cursorFile, '0'); // the shared script cursor resets too
      return reply(res, 200, { ok: true, label: LABEL });
    }
    return reply(res, 200, facts);
  }
  if (req.method === 'GET' && (pathOnly === '/v1/models' || pathOnly === '/models')) {
    return reply(res, 200, { data: [{ id: `${MODEL}:free` }, { id: MODEL }] });
  }
  const isChat = req.method === 'POST' && (pathOnly === '/chat/completions' || pathOnly === '/v1/chat/completions');
  if (!isChat) return reply(res, 404, { error: { message: `mock ${LABEL}: no such route` } });

  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 8 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* junk body → still answer the script */ }
    const n = facts.requests; // the LOCAL request number (for the log/facts)
    facts.requests += 1;
    facts.byPath[pathOnly] = (facts.byPath[pathOnly] || 0) + 1;
    const maxTokens = Number(body.max_tokens) || 0;
    const msgChars = Array.isArray(body.messages)
      ? body.messages.reduce((k, m) => k + (typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content ?? '').length), 0)
      : 0;
    facts.maxTokensSeen.push(maxTokens);
    facts.msgCharsSeen.push(msgChars);
    facts.log.push({ n, path: pathOnly, model: body.model || null, maxTokens, msgChars, at: new Date().toISOString() });

    const idx = nextScriptIndex();
    const text = script[Math.min(idx, script.length - 1)];
    const done = () =>
      reply(res, 200, {
        id: `mock-${LABEL}-${n}`,
        model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: Math.ceil(msgChars / 4), completion_tokens: Math.ceil(text.length / 4) },
      });
    if (DELAY > 0) {
      facts.delayMsTotal += DELAY;
      setTimeout(done, DELAY);
    } else {
      done();
    }
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock ${LABEL}] listening on http://127.0.0.1:${PORT} — model ${MODEL}, ${script.length} scripted replies, delay ${DELAY}ms`));
server.on('error', (e) => {
  console.error(`[mock ${LABEL}] cannot bind: ${e.message}`);
  process.exit(1);
});
