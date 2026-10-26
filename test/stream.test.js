// stream.test.js — streaming thoughts (v0.28.0): SSE/NDJSON readers, gateway
// streaming paths, thought extractor, chat.js delta wiring, /stream setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sseData,
  bodyChunks,
  streamOpenAI,
  streamNDJSON,
  openAIStreamOrBuffer,
  fetchStreaming,
} from '../src/brain/sse.js';
import { decodeJsonStringPart, makeThoughtExtractor, formatThought } from '../src/terminal/streamthought.js';
import { createKiloGateway } from '../src/brain/gateways/kilo.js';
import { createOllamaGateway } from '../src/brain/gateways/ollama.js';
import { GatewayRouter } from '../src/brain/router.js';
import { createChat } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';
import { setChatSetting, getChatSetting } from '../src/settings.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

/** A fetch Response whose body is a web ReadableStream of the given chunks. */
function sseResponse(lines, { ctype = 'text/event-stream', delayMs = 0 } = {}) {
  const stream = new ReadableStream({
    async start(ctrl) {
      for (const line of lines) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        ctrl.enqueue(enc.encode(line));
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': ctype } });
}

/** A body that emits one chunk then never closes (for the stall watchdog). */
function stallingResponse() {
  let kill = null;
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
      kill = (err) => ctrl.error(err);
    },
  });
  return {
    response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    kill,
  };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-stream-'));
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { tools, harness };
}

// ── SSE reader ────────────────────────────────────────────────────────────────

test('sseData: chunk boundaries, comments, keepalives, [DONE], CRLF', async () => {
  const res = sseResponse([
    'data: {"a":1}\ndata: {"a":2}\n\n',
    ': keepalive\n\n', // comment lines are skipped
    'event: ping\ndata: {"a":3}\r\n\r\n', // CRLF + event field ignored
    'data: [DONE]\n',
    'data: {"never":"reached"}\n',
  ]);
  const out = [];
  for await (const payload of sseData(res)) out.push(payload);
  assert.deepEqual(out, ['{"a":1}', '{"a":2}', '{"a":3}']);
});

test('sseData: payloads split mid-line across chunks still assemble', async () => {
  const res = sseResponse(['data: {"to', 'ol":"sa', 'y"}\n\n']);
  const out = [];
  for await (const p of sseData(res)) out.push(p);
  assert.deepEqual(out, ['{"tool":"say"}']);
});

test('bodyChunks: multibyte character split across chunks decodes cleanly', async () => {
  // "…" is 3 UTF-8 bytes; cut it in half across two chunks.
  const bytes = enc.encode('…');
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(bytes.slice(0, 2));
      ctrl.enqueue(bytes.slice(2));
      ctrl.enqueue(enc.encode('!'));
      ctrl.close();
    },
  });
  const res = new Response(stream, { headers: {} });
  let text = '';
  for await (const chunk of bodyChunks(res)) text += chunk;
  assert.equal(text, '…!');
});

test('bodyChunks: stall watchdog aborts a stream that stops sending bytes', async () => {
  const { response, kill } = stallingResponse();
  const aborter = { abort: null }; // bodyChunks calls abort() on stall
  const aborted = new Promise((resolve) => {
    aborter.abort = (reason) => resolve(reason);
  });
  const t0 = Date.now();
  // Start iterating (arms the watchdog), then wait for the stall to fire it.
  const run = (async () => {
    for await (const _ of bodyChunks(response, { idleMs: 60, aborter })) void _;
  })();
  const reason = await aborted; // watchdog fires ~idleMs in
  kill(new Error('aborted by watchdog')); // what a real fetch body does on abort
  await assert.rejects(() => run, /aborted|stalled/i);
  assert.ok(Date.now() - t0 < 5000, 'watchdog fired quickly');
  assert.match(String(reason?.message || reason), /stalled/);
});

test('fetchStreaming: returns the aborter and honors the headers timeout', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted: headers timeout')));
    });
  try {
    await assert.rejects(() => fetchStreaming('http://x/', {}, { timeoutMs: 40 }), /aborted|timeout/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── mappers ───────────────────────────────────────────────────────────────────

test('streamOpenAI: deltas in order, usage from the trailing chunk, ttms set', async () => {
  const res = sseResponse([
    'data: {"choices":[{"delta":{"content":"{\\"tool\\":"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"\\"say\\"}"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
    'data: [DONE]\n',
  ]);
  const seen = [];
  const out = await streamOpenAI(res, (d) => seen.push(d), {});
  assert.deepEqual(seen, ['{"tool":', '"say"}']);
  assert.equal(out.text, '{"tool":"say"}');
  assert.equal(out.usage.totalTokens, 15); // normalized by extractUsage
  assert.equal(out.chunks, 2);
  assert.ok(typeof out.ttms === 'number' && out.ttms >= 0);
});

test('streamOpenAI: array-style content parts are joined', async () => {
  const res = sseResponse(['data: {"choices":[{"delta":{"content":[{"text":"par"},{"text":"tial"}]}}]}\n\n', 'data: [DONE]\n']);
  const out = await streamOpenAI(res, null, {});
  assert.equal(out.text, 'partial');
});

test('streamNDJSON: ollama per-line deltas + done-line usage', async () => {
  const res = sseResponse(
    ['{"message":{"content":"hel"},"done":false}\n', '{"message":{"content":"lo"},"done":false}\n', '{"done":true,"prompt_eval_count":7,"eval_count":3}\n'],
    { ctype: 'application/x-ndjson' }
  );
  const seen = [];
  const out = await streamNDJSON(res, (d) => seen.push(d), {});
  assert.deepEqual(seen, ['hel', 'lo']);
  assert.equal(out.text, 'hello');
  assert.deepEqual(out.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
});

test('openAIStreamOrBuffer: SSE content-type streams, JSON content-type buffers', async () => {
  const sse = sseResponse(['data: {"choices":[{"delta":{"content":"live"}}]}\n\n', 'data: [DONE]\n']);
  const streamed = await openAIStreamOrBuffer(sse, null, {});
  assert.deepEqual({ text: streamed.text, streamed: streamed.streamed }, { text: 'live', streamed: true });

  const jsonBody = JSON.stringify({ choices: [{ message: { content: 'buffered' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  const buffered = await openAIStreamOrBuffer(sseResponse([jsonBody], { ctype: 'application/json' }), null, {});
  assert.deepEqual({ text: buffered.text, streamed: buffered.streamed }, { text: 'buffered', streamed: false });
});

// ── thought extractor ─────────────────────────────────────────────────────────

test('decodeJsonStringPart: escapes, dangling backslash, split \\u', () => {
  assert.equal(decodeJsonStringPart('a\\nb\\"c\\\\d'), 'a\nb"c\\d');
  assert.equal(decodeJsonStringPart('\\u0041\\u00e9'), 'Aé');
  assert.equal(decodeJsonStringPart('stop\\'), 'stop'); // dangling backslash dropped
  assert.equal(decodeJsonStringPart('x\\u00'), 'x'); // incomplete \u dropped
});

test('extractor: tool name, then args ticker, then message grows across pushes', () => {
  const ex = makeThoughtExtractor();
  assert.equal(ex.push('{"tool":"sa'), null); // no complete tool yet
  let s = ex.push('y","args":{"command":"npm te');
  assert.equal(s.tool, 'say'); // wait — tool completed on THIS push
  s = ex.push('st"}}');
  assert.equal(s.tool, 'say');
  assert.match(s.raw, /npm te/);
  s = ex.push('{"tool":"say","mess');
  s = ex.push('age":"hello ');
  s = ex.push('world\\nline2 \\"q\\"');
  // the escaped quotes around q decode AS THEY ARRIVE — they are content,
  // not the terminator; the string is still open (closed=false)
  assert.equal(s.message, 'hello world\nline2 "q"');
  assert.equal(s.messageClosed, false);
  s = ex.push('"}');
  assert.equal(s.messageClosed, true);
  assert.equal(s.message, 'hello world\nline2 "q"');
});

test('extractor: unicode escape split across pushes lands intact', () => {
  const ex = makeThoughtExtractor();
  ex.push('{"tool":"say","message":"caf');
  const s = ex.push('\\u00');
  assert.equal(s.message, 'caf');
  const s2 = ex.push('e9!”');
  assert.equal(s2.message, 'café!”');
});

test('extractor: reset clears state; formatThought caps and tail-ticks', () => {
  const ex = makeThoughtExtractor();
  ex.push('{"tool":"bash","args":{"command":"npm test"}}');
  ex.reset();
  assert.equal(ex.push('{"tool":"say","message":"new thought"}').message, 'new thought');

  const long = 'x'.repeat(200);
  const line = formatThought({ tool: 'say', message: long, messageClosed: false, raw: long }, 60);
  assert.ok(line.startsWith('✻ …'));
  assert.ok(line.length <= 60);

  const toolLine = formatThought({ tool: 'bash', message: '', raw: '{"tool":"bash","args":{"command":"npm test"}}' }, 80);
  assert.match(toolLine, /→ bash/);
  assert.match(toolLine, /npm test/);

  assert.equal(formatThought({ tool: null, message: '', raw: '{"too' }, 80), null);
});

// ── gateways over the wire (stubbed fetch) ────────────────────────────────────

test('kilo: streaming chat streams SSE deltas and reports usage + streamed flags', async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen-coder:free' }] }), { headers: { 'content-type': 'application/json' } });
    }
    bodies.push(JSON.parse(init.body));
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"{\\"tool\\":"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\"say\\",\\"message\\":\\"hi\\"}"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n',
      'data: [DONE]\n',
    ]);
  };
  try {
    const gw = createKiloGateway({ baseUrl: 'https://kilo.test', models: 'auto' }, { chatMs: 5000, httpMs: 2000 });
    const seen = [];
    const out = await gw.chat([{ role: 'user', content: 'go' }], { onDelta: (d) => seen.push(d) });
    assert.deepEqual(seen, ['{"tool":', '"say","message":"hi"}']);
    assert.equal(out.text, '{"tool":"say","message":"hi"}');
    assert.equal(out.streamed, true);
    assert.ok(out.ttms >= 0);
    assert.equal(out.usage.totalTokens, 16);
    assert.equal(out.model, 'qwen-coder:free');
    assert.equal(bodies[0].stream, true);
    assert.deepEqual(bodies[0].stream_options, { include_usage: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('kilo: relay that ignores stream:true falls back to buffered JSON (no crash)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen-coder:free' }] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"tool":"say","message":"buffered"}' } }] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const gw = createKiloGateway({ baseUrl: 'https://kilo.test', models: 'auto' }, { chatMs: 5000, httpMs: 2000 });
    const seen = [];
    const out = await gw.chat([{ role: 'user', content: 'go' }], { onDelta: (d) => seen.push(d) });
    assert.equal(out.text, '{"tool":"say","message":"buffered"}');
    assert.notEqual(out.streamed, true); // honestly not streamed
    assert.deepEqual(seen, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('ollama: NDJSON streaming deltas + mapped usage', async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init = {}) => {
    bodies.push(JSON.parse(init.body));
    return sseResponse(['{"message":{"content":"{\\"tool\\":\\"sa"},"done":false}\n', '{"message":{"content":"y}"},"done":false}\n', '{"done":true,"prompt_eval_count":9,"eval_count":2}\n'], {
      ctype: 'application/x-ndjson',
    });
  };
  try {
    const gw = createOllamaGateway({ baseUrl: 'http://localhost:11434' }, { chatMs: 5000, httpMs: 2000 });
    const seen = [];
    const out = await gw.chat([{ role: 'user', content: 'go' }], { onDelta: (d) => seen.push(d) });
    assert.deepEqual(seen, ['{"tool":"sa', 'y}']);
    assert.equal(out.text, '{"tool":"say}');
    assert.equal(out.streamed, true);
    assert.equal(out.usage.totalTokens, 11);
    assert.equal(bodies[0].stream, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('router: onDelta passes through to the gateway untouched', async () => {
  let got = null;
  const gw = {
    name: 'probe',
    chat: async (_messages, opts) => {
      got = opts;
      return { text: 'ok', model: 'm', gateway: 'probe' };
    },
  };
  const r = new GatewayRouter(new Map([['probe', gw]]), { gatewayOrder: ['probe'] });
  await r.chat([{ role: 'user', content: 'hi' }], { onDelta: () => {} });
  assert.equal(typeof got.onDelta, 'function');
});

// ── chat.js wiring ────────────────────────────────────────────────────────────

test('chat: deltas flow to onStream when streaming is enabled', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const calls = [];
  const router = {
    order: ['fake'],
    chat: async (messages, opts) => {
      calls.push(opts);
      // Simulate a gateway that streams its reply in two fragments.
      opts.onDelta?.('{"tool":"say","mess');
      opts.onDelta?.('age":"streamed hello"}');
      return { text: '{"tool":"say","message":"streamed hello"}', model: 'm', gateway: 'fake', latencyMs: 1 };
    },
  };
  const frags = [];
  const chat = createChat({ router, tools, harness, streaming: { enabled: true }, onStream: (f) => frags.push(f) });
  const out = await chat.turn('hi');
  assert.equal(out.said, 'streamed hello');
  assert.deepEqual(frags, ['{"tool":"say","mess', 'age":"streamed hello"}']);
  assert.equal(typeof calls[0].onDelta, 'function');
});

test('chat: streaming disabled → no onDelta reaches the router', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const calls = [];
  const router = {
    order: ['fake'],
    chat: async (messages, opts) => {
      calls.push(opts);
      return { text: '{"tool":"say","message":"buffered"}', model: 'm', gateway: 'fake', latencyMs: 1 };
    },
  };
  const frags = [];
  const chat = createChat({ router, tools, harness, streaming: { enabled: false }, onStream: (f) => frags.push(f) });
  const out = await chat.turn('hi');
  assert.equal(out.said, 'buffered');
  assert.deepEqual(frags, []);
  assert.equal(calls[0].onDelta, undefined);
});

test('chat: no onStream listener → buffered call, protocol untouched', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const calls = [];
  const router = {
    order: ['fake'],
    chat: async (messages, opts) => {
      calls.push(opts);
      return { text: '{"tool":"say","message":"quiet"}', model: 'm', gateway: 'fake', latencyMs: 1 };
    },
  };
  const chat = createChat({ router, tools, harness });
  const out = await chat.turn('hi');
  assert.equal(out.said, 'quiet');
  assert.equal(calls[0].onDelta, undefined);
});

// ── /stream persistence ───────────────────────────────────────────────────────

test('settings: chat.stream round-trips (the /stream on|off surface)', () => {
  const root = tmpRoot();
  assert.equal(getChatSetting(root, 'stream', true), true); // default on
  setChatSetting(root, 'stream', false);
  assert.equal(getChatSetting(root, 'stream', true), false);
  setChatSetting(root, 'stream', true);
  assert.equal(getChatSetting(root, 'stream', true), true);
});
