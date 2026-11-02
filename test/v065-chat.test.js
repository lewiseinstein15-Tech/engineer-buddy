// Tests for the v0.65 chat wave: the context-window fallback — overflow →
// compact hard → ONE retry, bounded (the fs-tool tests live in
// v065-tools.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat, isContextOverflow } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { tools, harness };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v065-'));
}

test('isContextOverflow: relays name it differently, network noise is not overflow', () => {
  for (const msg of [
    "This model's maximum context length is 8192 tokens. However, your messages resulted in 9123 tokens.",
    'Request too large: prompt is too long — reduce the length',
    'input length exceeds the context window',
    'token limit exceeded',
  ]) {
    const e = new Error(msg);
    e.code = 'HTTP_400';
    assert.equal(isContextOverflow(e), true, msg);
  }
  assert.equal(isContextOverflow(new Error('fetch failed')), false);
  assert.equal(isContextOverflow(new Error('ollama: unreachable')), false);
  assert.equal(isContextOverflow(new Error('HTTP 502 bad gateway')), false);
});

test('context-window fallback: overflow mid-turn → compaction → ONE retry → turn survives', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  for (const f of ['big1.txt', 'big2.txt', 'big3.txt']) {
    fs.writeFileSync(path.join(root, f), 'x'.repeat(4000));
  }
  const calls = [];
  let n = 0;
  const router = {
    order: ['fake'],
    chat: async (messages, opts) => {
      n++;
      calls.push(n);
      if (n === 4) {
        const e = new Error("This model's maximum context length is 8192 tokens. However, your messages resulted in 9123 tokens.");
        e.code = 'HTTP_400';
        throw e;
      }
      const text =
        n <= 3
          ? `{"tool":"fs_read","args":{"path":"big${n}.txt"}}`
          : n === 5
            ? 'Earlier: read big1-3 to fill the window.'
            : '{"tool":"say","message":"recovered after compaction"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
  const events = [];
  const chat = createChat({ router, tools, harness, onEvent: (e) => events.push(e) });
  const out = await chat.turn('read the three files and summarize');
  assert.equal(out.said, 'recovered after compaction');
  assert.notEqual(out.error, true);
  assert.ok(events.some((e) => e.type === 'error' && /context overflow/.test(e.text)), 'the overflow is named');
  assert.ok(events.some((e) => e.type === 'compaction'), 'compaction actually ran');
  assert.equal(calls.length, 6, `expected 6 calls (3 reads + overflow + summary + say), got ${calls.length}`);
});

test('context-window fallback: second overflow dies bounded — no retry loop', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  for (const f of ['big1.txt', 'big2.txt', 'big3.txt']) {
    fs.writeFileSync(path.join(root, f), 'x'.repeat(4000));
  }
  let n = 0;
  const router = {
    order: ['fake'],
    chat: async () => {
      n++;
      if (n === 4 || n === 6) {
        const e = new Error('prompt is too long: input length exceeds the context window');
        e.code = 'HTTP_400';
        throw e;
      }
      const text = n <= 3 ? `{"tool":"fs_read","args":{"path":"big${n}.txt"}}` : n === 5 ? 'summary text' : '{"tool":"say","message":"unreachable"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
  const events = [];
  const chat = createChat({ router, tools, harness, onEvent: (e) => events.push(e) });
  const out = await chat.turn('read the three files and summarize');
  assert.equal(out.said, null);
  assert.equal(out.error, true);
  assert.ok(events.some((e) => e.type === 'error' && /brain offline after context retry/.test(e.text)));
  assert.equal(n, 6, 'exactly one retry — no loop');
});
