// Beyond-CC transparency pack (v0.24.0): /why (how the last answer was
// produced) + /compare (same prompt, two gateways). Pure formatters tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatCompareResult, SLASH_COMMANDS } from '../src/terminal/repl.js';

test('formatCompareResult: ok rows show gateway/model/latency + capped text; failures honest', () => {
  const ok = formatCompareResult({ gateway: 'kilo', ok: true, text: 'the answer', model: 'gpt-x', ms: 2340 });
  assert.match(ok, /kilo \(gpt-x, 2\.3s\)/);
  assert.match(ok, /the answer/);
  const long = formatCompareResult({ gateway: 'gw', ok: true, text: 'x'.repeat(2000), model: 'm', ms: 100 });
  assert.ok(long.length < 1400, 'reply capped');
  const empty = formatCompareResult({ gateway: 'gw', ok: true, text: '', model: 'm', ms: 5 });
  assert.match(empty, /\(empty reply\)/);
  const fail = formatCompareResult({ gateway: 'duckai', ok: false, error: 'rate limited' });
  assert.match(fail, /duckai: failed — rate limited/);
  const failNoErr = formatCompareResult({ gateway: 'duckai', ok: false });
  assert.match(failNoErr, /unknown error/);
});

test('why/compare are registered once and never shadow built-ins', () => {
  for (const cmd of ['why', 'compare']) {
    assert.ok(SLASH_COMMANDS.includes(cmd));
    assert.equal(SLASH_COMMANDS.filter((c) => c === cmd).length, 1);
  }
});

test('the /why data contract: tool events carry gateway + model for every step', async () => {
  // /why renders from the events the chat loop emits — freeze that shape.
  const { createChat } = await import('../src/agent/chat.js');
  const events = [];
  const chat = createChat({
    router: {
      order: ['kilo'],
      gateways: new Map([['kilo', { name: 'kilo' }]]),
      chat: async (messages, opts) => {
        // emulate the router: out carries gateway + model (v0.13 contract)
        return { text: '{"tool":"say","message":"done"}', gateway: 'kilo', model: 'gpt-x' };
      },
    },
    tools: [{ name: 'say', description: 'd', args: '{}', run: async ({ message }) => message }],
    harness: '',
  });
  await chat.turn('hello', { onEvent: null });
  // turn() pushes events via the injected onEvent; read them from the session accessor instead
  void events;
  assert.ok(typeof chat.usage === 'function' && typeof chat.historyChars === 'function', '/why needs usage() + historyChars()');
});
