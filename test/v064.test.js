// v064.test.js — the catalog is the enemy (2026-10-31 live-wire lesson). The
// v0.63.0 ladder was never the broken leg: the wire probe proved the relay
// HONORS max_tokens (cut position scales 1500→3000). The enemy was the MODEL
// CHOICE: kilo's pickModel preferred reasoning-flavored free models, which
// stream invisible delta.reasoning_content, burn the ENTIRE output budget on
// it, and answer EMPTY content after ~135s of total silence — from the user's
// chair, the type box just blinks for minutes and the turn dies on failover
// churn. Covers: reasoningChars on both wire paths, the same-call candidate
// rotation (reasoning-only / inline 200 error / empty content), the 10-minute
// blacklist, reasoning-name demotion, the bounded all-bad death, the 429
// passthrough (never rotated, never blacklisted), the one-write renderer
// (the blinking type box), and the ≤1200-chars teaching pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openAIStreamOrBuffer } from '../src/brain/sse.js';
import { createKiloGateway } from '../src/brain/gateways/kilo.js';
import { RateLimitError } from '../src/util.js';
import { createRenderer } from '../src/terminal/renderer.js';
import { PROTOCOL_PREAMBLE } from '../src/agent/chat.js';

// One catalog for the whole file — the module-level model cache (1h TTL)
// means every stubbed /v1/models in this process must agree on the ids.
const CATALOG = ['mock-reasoning:free', 'mock-coder:free', 'mock-mini:free'];

const mkModels = () =>
  new Response(JSON.stringify({ data: CATALOG.map((id) => ({ id })) }), {
    headers: { 'content-type': 'application/json' },
  });

function sseRes(frames, ctype = 'text/event-stream') {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? ctype : null) },
    body: (async function* () {
      for (const f of frames) yield Buffer.from(f);
    })(),
  };
}

const okReply = '{"tool":"say","message":"the real answer"}';

// ── the wire sees reasoning (v0.64.0) ────────────────────────────────────────

test('openAIStreamOrBuffer: SSE reasoning_content deltas count as reasoningChars, content still parses', async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking hard ' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'about the budget' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: okReply } }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const out = await openAIStreamOrBuffer(sseRes(frames), null, { idleMs: 5000, totalMs: 5000 });
  assert.equal(out.reasoningChars, 'thinking hard about the budget'.length);
  assert.equal(out.text, okReply);
  assert.equal(out.truncated, false);
});

test('openAIStreamOrBuffer: OpenRouter-shape delta.reasoning is counted too', async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'deep thoughts' } }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const out = await openAIStreamOrBuffer(sseRes(frames), null, { idleMs: 5000, totalMs: 5000 });
  assert.equal(out.reasoningChars, 'deep thoughts'.length);
  assert.equal(out.text, ''); // nothing else arrived
});

test('openAIStreamOrBuffer: buffered message.reasoning counts; absence is 0', async () => {
  const withR = { choices: [{ message: { content: okReply, reasoning: 'hidden thinking' }, finish_reason: 'stop' }] };
  const out1 = await openAIStreamOrBuffer(
    { headers: { get: () => 'application/json' }, json: async () => withR },
    null
  );
  assert.equal(out1.reasoningChars, 'hidden thinking'.length);
  const noR = { choices: [{ message: { content: okReply }, finish_reason: 'stop' }] };
  const out2 = await openAIStreamOrBuffer(
    { headers: { get: () => 'application/json' }, json: async () => noR },
    null
  );
  assert.equal(out2.reasoningChars, 0);
});

// ── kilo rotation: content or it didn't happen ───────────────────────────────

function stubFetch(bodies, handler) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) return mkModels();
    bodies.push(JSON.parse(init.body));
    return handler(JSON.parse(init.body));
  };
  return () => {
    globalThis.fetch = real;
  };
}

test('kilo: a reasoning-only reply rotates to the next candidate in the SAME call (preferred model honored first)', async () => {
  const bodies = [];
  const done = stubFetch(bodies, (b) => {
    if (b.model === 'mock-reasoning:free') {
      // the 2026-10-31 nemotron shape: all budget burned on reasoning, empty content
      return sseRes([
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'x'.repeat(5000) } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    }
    return sseRes([
      `data: ${JSON.stringify({ choices: [{ delta: { content: okReply } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  });
  try {
    const gw = createKiloGateway(
      { baseUrl: 'https://kilo.test', models: 'auto', preferredModels: ['mock-reasoning:free'] },
      { chatMs: 5000, httpMs: 2000 }
    );
    const out = await gw.chat([{ role: 'user', content: 'go' }], { onDelta: () => {} });
    assert.equal(out.text, okReply);
    assert.equal(out.model, 'mock-coder:free'); // the rotation landed on the codeish plain model
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].model, 'mock-reasoning:free'); // the operator's preference was tried first
    assert.equal(bodies[1].model, 'mock-coder:free'); // …and rotated within the SAME call
  } finally {
    done();
  }
});

test('kilo: the blacklist holds — the next call skips the bad model entirely', async () => {
  const bodies = [];
  const done = stubFetch(bodies, (b) => {
    if (b.model === 'mock-reasoning:free') {
      return sseRes([
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'x'.repeat(5000) } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    }
    return sseRes([
      `data: ${JSON.stringify({ choices: [{ delta: { content: okReply } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  });
  try {
    const gw = createKiloGateway(
      { baseUrl: 'https://kilo.test', models: 'auto', preferredModels: ['mock-reasoning:free'] },
      { chatMs: 5000, httpMs: 2000 }
    );
    await gw.chat([{ role: 'user', content: 'call 1' }], { onDelta: () => {} }); // rotation → blacklist
    const before = bodies.length;
    const out = await gw.chat([{ role: 'user', content: 'call 2' }], { onDelta: () => {} });
    assert.equal(out.model, 'mock-coder:free');
    const modelsAsked = bodies.slice(before).map((b) => b.model);
    assert.deepEqual(modelsAsked, ['mock-coder:free']); // the blacklisted model was never asked again
  } finally {
    done();
  }
});

test('kilo: an inline HTTP-200 error envelope is a model-level failure → rotation', async () => {
  const bodies = [];
  const done = stubFetch(bodies, (b) => {
    if (b.model === 'mock-coder:free') {
      // witnessed live 2026-10-31: HTTP 200, {"error":{"code":502,...}}, no choices
      return new Response(JSON.stringify({ error: { message: 'Inference connection error', code: 502, metadata: { error_type: 'provider_unavailable' } } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return sseRes([
      `data: ${JSON.stringify({ choices: [{ delta: { content: okReply } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  });
  try {
    const gw = createKiloGateway({ baseUrl: 'https://kilo.test', models: 'auto' }, { chatMs: 5000, httpMs: 2000 });
    const out = await gw.chat([{ role: 'user', content: 'go' }], { onDelta: () => {} });
    assert.equal(out.text, okReply);
    assert.equal(bodies[0].model, 'mock-coder:free'); // the codeish model failed upstream
    assert.equal(bodies[1].model, 'mock-mini:free'); // …the call rotated to the next plain candidate
  } finally {
    done();
  }
});

test('kilo: buffered empty content rotates; the honest message names the model', async () => {
  const bodies = [];
  const done = stubFetch(bodies, (b) => {
    if (b.model === 'mock-coder:free') {
      return new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: okReply }, finish_reason: 'stop' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const gw = createKiloGateway({ baseUrl: 'https://kilo.test', models: 'auto' }, { chatMs: 5000, httpMs: 2000 });
    const out = await gw.chat([{ role: 'user', content: 'go' }]);
    assert.equal(out.text, okReply);
    assert.equal(out.model, 'mock-mini:free');
    assert.equal(bodies.length, 2);
  } finally {
    done();
  }
});

test('kilo: 429 is the ROUTER\u2019s business — rethrown immediately, never rotated, never blacklisted', async () => {
  const bodies = [];
  const done = stubFetch(bodies, () => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'retry-after': '3' } }));
  try {
    const gw = createKiloGateway({ baseUrl: 'https://kilo.test', models: 'auto' }, { chatMs: 5000, httpMs: 2000 });
    await assert.rejects(() => gw.chat([{ role: 'user', content: 'go' }]), RateLimitError);
    assert.equal(bodies.length, 1); // no rotation on a gateway-wide park
    // and the model was NOT blacklisted: the next call asks the same codeish model first
    const second = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) return mkModels();
      second.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: okReply }, finish_reason: 'stop' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const out = await gw.chat([{ role: 'user', content: 'go' }]);
    assert.equal(second[0].model, 'mock-coder:free');
    assert.equal(out.model, 'mock-coder:free');
  } finally {
    done();
  }
});

test('kilo: every candidate bad dies BOUNDED (3 attempts) with the honest diagnosis', async () => {
  const bodies = [];
  const done = stubFetch(bodies, () =>
    sseRes([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'x'.repeat(2000) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
      'data: [DONE]\n\n',
    ])
  );
  try {
    const gw = createKiloGateway({ baseUrl: 'https://kilo.test', models: 'auto' }, { chatMs: 5000, httpMs: 2000 });
    await assert.rejects(
      () => gw.chat([{ role: 'user', content: 'go' }], { onDelta: () => {} }),
      /produced NO content.*reasoning tokens.*blacklisted/s
    );
    assert.equal(bodies.length, 3); // bounded — a bad catalog must not multiply latency unboundedly
  } finally {
    done();
  }
});

test('kilo: reasoning-flavored names are DEMOTED below plain candidates', async () => {
  const bodies = [];
  const done = stubFetch(bodies, (b) =>
    sseRes([
      `data: ${JSON.stringify({ choices: [{ delta: { content: okReply } }] })}\n\n`,
      'data: [DONE]\n\n',
    ])
  );
  try {
    const gw = createKiloGateway({ baseUrl: 'https://kilo.test', models: 'auto' }, { chatMs: 5000, httpMs: 2000 });
    const out = await gw.chat([{ role: 'user', content: 'go' }], { onDelta: () => {} });
    assert.equal(bodies[0].model, 'mock-coder:free'); // plain + codeish beats reasoning-flavored, catalog order be damned
    assert.equal(out.model, 'mock-coder:free');
  } finally {
    done();
  }
});

test('kilo: an explicit model arg (router pin) is never silently substituted', async () => {
  const bodies = [];
  const done = stubFetch(bodies, () =>
    sseRes([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'x' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ])
  );
  try {
    const gw = createKiloGateway({ baseUrl: 'https://kilo.test', models: 'auto' }, { chatMs: 5000, httpMs: 2000 });
    await assert.rejects(() => gw.chat([{ role: 'user', content: 'go' }], { model: 'mock-reasoning:free', onDelta: () => {} }), /NO content/);
    assert.equal(bodies.length, 1); // the pin reported its own failure honestly — the ROUTER failovers
  } finally {
    done();
  }
});

// ── the blinking type box: the renderer paints in ONE write ─────────────────

function mkOut() {
  const writes = [];
  return { writes, columns: 40, write: (s) => writes.push(s) };
}

test('renderer: render() coalesces erase + frame into exactly ONE write', () => {
  const out = mkOut();
  let frameText = ['line one', 'line two'];
  const r = createRenderer({ out, frame: () => frameText });
  r.render(); // first paint: nothing on screen yet, so no erase — just the frame
  assert.equal(out.writes.length, 1);
  assert.equal(out.writes[0], 'line one\nline two');
  // an unchanged frame costs ZERO bytes — the spinner tick of a static box no longer repaints
  r.render();
  assert.equal(out.writes.length, 1);
  frameText = ['line one', 'line two!'];
  r.render(); // a CHANGED frame repaints erase + frame back to back in ONE write
  assert.equal(out.writes.length, 2);
  assert.ok(out.writes[1].startsWith('\r'));
  assert.ok(out.writes[1].includes('\x1b[J'));
  assert.ok(out.writes[1].endsWith('line one\nline two!'));
});

test('renderer: print() coalesces erase + content + re-anchored frame into ONE write', () => {
  const out = mkOut();
  const r = createRenderer({ out, frame: () => ['> prompt'] });
  r.render(); // paint the box
  assert.equal(out.writes.length, 1);
  r.print('hello world\n'); // now there IS a frame on screen: erase + content + frame, one write
  assert.equal(out.writes.length, 2);
  const w = out.writes[1];
  assert.ok(w.startsWith('\r')); // erase begins at column 1…
  assert.ok(w.includes('\x1b[J'));
  assert.ok(w.includes('hello world\n'));
  assert.ok(w.endsWith('> prompt')); // …and the frame rides the SAME write
});

test('renderer: an empty frame erases and stops; the next real frame paints again', () => {
  const out = mkOut();
  let frameText = ['box'];
  const r = createRenderer({ out, frame: () => frameText });
  r.render();
  assert.equal(out.writes.length, 1);
  frameText = [];
  r.render();
  assert.equal(out.writes.length, 2); // erase-only
  assert.equal(r.rows, 0);
  frameText = ['back'];
  r.render();
  assert.equal(out.writes.length, 3);
  assert.ok(out.writes[2].endsWith('back'));
});

// ── the teaching: concrete chunk sizes (weak models need numbers) ────────────

test('the preamble teaches ≤1200-character chunks (fs_write then fs_append)', () => {
  assert.match(PROTOCOL_PREAMBLE, /fs_write the first part \(≤1200 characters\)/);
  assert.match(PROTOCOL_PREAMBLE, /fs_append the rest in follow-up calls of ≤1200 characters each/);
});

test('source pin: both repair ladders teach the same ≤1200 numbers', () => {
  const chatSrc = fs.readFileSync(new URL('../src/agent/chat.js', import.meta.url), 'utf8');
  const agentSrc = fs.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
  for (const [name, src] of [['chat.js', chatSrc], ['agent.js', agentSrc]]) {
    assert.match(src, /payload of ≤1200 characters/, `${name} TRUNCATION_MSG carries the concrete chunk size`);
    assert.match(src, /fs_write the first ≤1200 characters/, `${name} TRUNCATION_MSG carries the split teaching`);
  }
});
