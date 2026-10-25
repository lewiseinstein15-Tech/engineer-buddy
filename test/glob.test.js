// glob.test.js — the glob tool: pure-JS path matching (zero-dep).
//
// The model keeps asking path questions ("where do the tests live?") with
// fs_search, which is a CONTENT tool. glob answers path questions directly:
// ** globstars, *, ?, [abc] classes, {a,b} braces. Read-only, so it is
// allowed in plan mode too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalRepo, expandBraces, globToRegExp } from '../src/tools/repo.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { PLAN_TOOLS } from '../src/tools/planmode.js';
import { createChat } from '../src/agent/chat.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

function makeRepoTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-glob-'));
  for (const rel of [
    'src/index.js',
    'src/lib/util.js',
    'src/lib/deep/nested.js',
    'src/lib/deep/nested.test.js',
    'test/smoke.test.js',
    'README.md',
    'node_modules/pkg/index.js', // must NEVER match
    '.hidden/secret.js', // dot-dirs are invisible to the walk
  ]) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '// x\n');
  }
  return root;
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { scope, tools, harness };
}

test('globToRegExp: globstars, single stars, question marks', () => {
  assert.ok(globToRegExp('src/**/*.js').test('src/a.js'));
  assert.ok(globToRegExp('src/**/*.js').test('src/x/y/a.js'));
  assert.ok(!globToRegExp('src/**/*.js').test('lib/a.js'));
  assert.ok(globToRegExp('*.md').test('README.md'));
  assert.ok(!globToRegExp('*.md').test('docs/README.md')); // * never crosses /
  assert.ok(globToRegExp('test?.js').test('test1.js'));
  assert.ok(!globToRegExp('test?.js').test('test12.js'));
});

test('globToRegExp: char classes and bare **', () => {
  assert.ok(globToRegExp('test[0-9].js').test('test3.js'));
  assert.ok(!globToRegExp('test[0-9].js').test('testx.js'));
  assert.ok(globToRegExp('test[!0-9].js').test('testx.js'));
  assert.ok(globToRegExp('**').test('any/thing/at/all.js'));
});

test('expandBraces: expands, including multiple groups', () => {
  assert.deepEqual(expandBraces('x.{js,ts}'), ['x.js', 'x.ts']);
  assert.deepEqual(expandBraces('{a,b}.{c,d}'), ['a.c', 'a.d', 'b.c', 'b.d']);
  assert.deepEqual(expandBraces('plain.txt'), ['plain.txt']);
});

test('globFiles: matches the real tree, sorted, skipping junk dirs', () => {
  const repo = new LocalRepo(makeRepoTree());
  assert.deepEqual(repo.globFiles('src/**/*.js'), ['src/index.js', 'src/lib/deep/nested.js', 'src/lib/deep/nested.test.js', 'src/lib/util.js']);
  assert.deepEqual(repo.globFiles('**/*.test.js'), ['src/lib/deep/nested.test.js', 'test/smoke.test.js']);
  assert.deepEqual(repo.globFiles('*.md'), ['README.md']);
  assert.deepEqual(repo.globFiles('**/node_modules/**'), []); // junk is invisible
  assert.deepEqual(repo.globFiles('.hidden/*.js'), []); // dot-dirs too
});

test('globFiles: braces and caps', () => {
  const repo = new LocalRepo(makeRepoTree());
  assert.deepEqual(repo.globFiles('**/*.{test,spec}.js'), ['src/lib/deep/nested.test.js', 'test/smoke.test.js']);
  assert.equal(repo.globFiles('**/*.js', { max: 2 }).length, 2, 'result cap respected');
});

test('glob tool: end-to-end output and errors', async () => {
  const root = makeRepoTree();
  const { scope, tools } = makeBuddy(root);
  const glob = tools.find((t) => t.name === 'glob');
  const out = await glob.run({ pattern: 'src/**/*.js' });
  assert.match(out, /^4 file\(s\):/);
  assert.match(out, /src\/lib\/deep\/nested\.test\.js/);
  const none = await glob.run({ pattern: '**/*.py' });
  assert.match(none, /\(no files match/);
  assert.match(await glob.run({ pattern: '' }), /pattern required/);
  assert.throws(() => scope.glob('../etc/**'), /unsafe glob pattern/);
  assert.throws(() => scope.glob(undefined), /pattern required/);
});

test('glob is registered in the chat loop and allowed in plan mode', async () => {
  const root = makeRepoTree();
  const { tools, harness } = makeBuddy(root);
  assert.ok(tools.some((t) => t.name === 'glob'), 'glob is registered');
  assert.ok(PLAN_TOOLS.has('glob'), 'glob is plan-mode safe');
  // plan-mode hard wall lets glob through
  const chat = createChat({
    router: {
      order: ['fake'],
      chat: async () => ({ text: '{"tool":"glob","args":{"pattern":"**/*.test.js"}}', model: 'fake', gateway: 'fake', latencyMs: 1 }),
    },
    tools,
    harness,
    modes: { plan: true },
  });
  const events = [];
  const orig = chat.turn.bind(chat);
  // capture the tool event by wrapping onEvent indirectly: run one step then abort
  let observation = null;
  const evChat = createChat({
    router: {
      order: ['fake'],
      chat: async () => ({ text: '{"tool":"glob","args":{"pattern":"**/*.test.js"}}', model: 'fake', gateway: 'fake', latencyMs: 1 }),
    },
    tools,
    harness,
    modes: { plan: true },
    onEvent: (e) => {
      if (e.type === 'tool') {
        observation = e.observation;
        throw new Error('stop-after-one-step');
      }
    },
  });
  await evChat.turn('list the test files').catch(() => {});
  assert.ok(observation, 'glob ran inside plan mode');
  assert.match(observation, /2 file\(s\):/);
  assert.match(observation, /test\/smoke\.test\.js/);
  void chat;
  void orig;
});
