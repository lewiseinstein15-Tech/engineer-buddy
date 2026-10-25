// multiedit.test.js — multi_edit (atomic batch edits) + fs_replace hardening
// (replace_all, line-numbered ambiguity errors, file-freshness guard).
//
// The v0.9.6 live test ended with a half-applied fs_replace and no way to
// notice the file had drifted. The freshness guard refuses edits to files
// changed outside the agent's tools; multi_edit makes multi-spot changes
// to one file all-or-nothing so half-applied batches cannot happen again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { createChat } from '../src/agent/chat.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';
import { listCheckpoints } from '../src/agent/checkpoints.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-multiedit-'));
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { scope, tools, harness };
}

const SAMPLE = `function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return alpha();\n}\n\nfunction alpha() {\n  return 2;\n}\n`;

test('multi_edit: applies several edits to one file atomically', async () => {
  const root = tmpRoot();
  const { scope, tools } = makeBuddy(root);
  fs.writeFileSync(path.join(root, 'src.js'), SAMPLE);
  scope.read('src.js');
  const me = tools.find((t) => t.name === 'multi_edit');
  const out = await me.run({ path: 'src.js', edits: [{ find: 'return 1;', replace: 'return 11;' }, { find: 'return alpha();', replace: 'return alpha() + 1;' }] });
  assert.match(out, /OK multi_edit src\.js: 2 edits applied/);
  const after = fs.readFileSync(path.join(root, 'src.js'), 'utf8');
  assert.match(after, /return 11;/);
  assert.match(after, /return alpha\(\) \+ 1;/);
  // one checkpoint, tagged multi_edit
  const cks = listCheckpoints(root, 5);
  assert.ok(cks.some((c) => c.tool === 'multi_edit' && c.files.some((f) => f.path === 'src.js')));
});

test('multi_edit: one bad edit aborts the WHOLE batch (file untouched)', async () => {
  const root = tmpRoot();
  const { scope, tools } = makeBuddy(root);
  fs.writeFileSync(path.join(root, 'src.js'), SAMPLE);
  scope.read('src.js');
  const me = tools.find((t) => t.name === 'multi_edit');
  await assert.rejects(
    () => me.run({ path: 'src.js', edits: [{ find: 'return 1;', replace: 'return 11;' }, { find: 'NOT IN FILE', replace: 'x' }] }),
    /edit 2 — snippet not found[\s\S]*file NOT changed/
  );
  assert.equal(fs.readFileSync(path.join(root, 'src.js'), 'utf8'), SAMPLE, 'file is byte-identical after a failed batch');
  assert.throws(() => scope.multiReplace('src.js', []), /non-empty array/);
  await assert.rejects(() => me.run({ path: 'src.js', edits: [{ replace: 'no find' }] }), /missing "find"/);
});

test('multi_edit: ambiguous edit lists line numbers; replace_all rescues', async () => {
  const root = tmpRoot();
  const { scope, tools } = makeBuddy(root);
  fs.writeFileSync(path.join(root, 'src.js'), SAMPLE); // "function alpha" appears twice: lines 1 and 9
  scope.read('src.js');
  const me = tools.find((t) => t.name === 'multi_edit');
  await assert.rejects(() => me.run({ path: 'src.js', edits: [{ find: 'function alpha', replace: 'fn alpha' }] }), /matches 2 times \(lines 1, 9\)/);
  const out = await me.run({ path: 'src.js', edits: [{ find: 'function alpha', replace: 'fn alpha', replace_all: true }] });
  assert.match(out, /OK multi_edit/);
  const after = fs.readFileSync(path.join(root, 'src.js'), 'utf8');
  assert.equal(after.split('fn alpha').length - 1, 2);
});

test('fs_replace: replace_all swaps every occurrence and reports the count', async () => {
  const root = tmpRoot();
  const { scope, tools } = makeBuddy(root);
  fs.writeFileSync(path.join(root, 'src.js'), SAMPLE);
  scope.read('src.js');
  const fr = tools.find((t) => t.name === 'fs_replace');
  const out = await fr.run({ path: 'src.js', find: 'return', replace: 'yield', replace_all: true });
  assert.match(out, /OK replaced 3 occurrences/);
  assert.equal(fs.readFileSync(path.join(root, 'src.js'), 'utf8').split('yield').length - 1, 3);
});

test('fs_replace: ambiguity error now names the matching lines', async () => {
  const root = tmpRoot();
  const { scope, tools } = makeBuddy(root);
  fs.writeFileSync(path.join(root, 'src.js'), SAMPLE);
  scope.read('src.js');
  const fr = tools.find((t) => t.name === 'fs_replace');
  await assert.rejects(() => fr.run({ path: 'src.js', find: 'function alpha', replace: 'x' }), /matches 2 times in src\.js \(lines 1, 9\)/);
});

test('freshness guard: an externally modified file refuses edits until re-read', async () => {
  const root = tmpRoot();
  const { scope } = makeBuddy(root);
  const p = path.join(root, 'src.js');
  fs.writeFileSync(p, 'const a = 1;\n');
  scope.read('src.js');
  // something else (bash, the user, another process) changes the file
  fs.writeFileSync(p, 'const a = 999; // mangled by someone else\n');
  assert.throws(
    () => scope.replace('src.js', 'const a = 1;', 'const a = 2;'),
    (e) => e.code === 'STALE_FILE' && /changed since you last read it[\s\S]*fs_read it again/.test(e.message)
  );
  assert.throws(() => scope.write('src.js', 'rewrite attempt'), /changed since you last read it/);
  assert.throws(() => scope.append('src.js', 'more'), /changed since you last read it/);
  // re-read → guard refreshed → edit succeeds
  scope.read('src.js');
  scope.replace('src.js', '999', '42');
  assert.match(fs.readFileSync(p, 'utf8'), /const a = 42;/);
});

test('freshness guard: the agent\u2019s own edits never trip it', async () => {
  const root = tmpRoot();
  const { scope } = makeBuddy(root);
  const p = path.join(root, 'src.js');
  fs.writeFileSync(p, 'step one;\n');
  scope.read('src.js');
  scope.replace('src.js', 'one', 'uno');
  scope.replace('src.js', 'uno', 'ein');
  scope.append('src.js', 'step two;\n');
  scope.write('src.js', 'fresh content\n');
  assert.equal(fs.readFileSync(p, 'utf8'), 'fresh content\n');
});

test('freshness guard: previews use peek and never refresh the baseline', async () => {
  const root = tmpRoot();
  const { scope, tools } = makeBuddy(root);
  const p = path.join(root, 'src.js');
  fs.writeFileSync(p, 'const a = 1;\n');
  scope.read('src.js');
  fs.writeFileSync(p, 'const a = 2; // external\n');
  // rendering the approval preview must not make the file look fresh again
  const fr = tools.find((t) => t.name === 'fs_replace');
  fr.preview({ path: 'src.js', find: 'const a = 2;', replace: 'const a = 3;' });
  assert.throws(() => scope.replace('src.js', 'const a = 2;', 'const a = 3;'), /changed since you last read it/);
});

test('multi_edit rides the approval gate with a rendered preview', async () => {
  const root = tmpRoot();
  const { tools } = makeBuddy(root);
  fs.writeFileSync(path.join(root, 'src.js'), 'one\ntwo\n');
  const me = tools.find((t) => t.name === 'multi_edit');
  assert.equal(me.risky, true, 'multi_edit is gated');
  const preview = me.preview({ path: 'src.js', edits: [{ find: 'one', replace: 'uno' }] });
  assert.ok(preview && /uno/.test(preview), 'preview renders the combined diff');
});

test('chat loop: multi_edit error path returns an ERROR observation, not a crash', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  fs.writeFileSync(path.join(root, 'src.js'), 'x\n');
  const events = [];
  const chat = createChat({
    router: {
      order: ['fake'],
      chat: async () => ({
        text: '{"tool":"multi_edit","args":{"path":"src.js","edits":[{"find":"missing","replace":"y"}]}}',
        model: 'fake',
        gateway: 'fake',
        latencyMs: 1,
      }),
    },
    tools,
    harness,
    approval: () => 'yes',
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'tool') throw new Error('stop-after-one-step'); // one step is all we need
    },
  });
  await chat.turn('edit it').catch(() => {});
  const ev = events.find((e) => e.type === 'tool');
  assert.equal(ev.tool, 'multi_edit');
  assert.match(ev.observation, /ERROR: multi_edit: edit 1 — snippet not found/);
});
