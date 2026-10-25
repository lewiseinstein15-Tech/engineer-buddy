// repomap.test.js — the aider-style repo map (P1): files + top-level symbols,
// churn-ranked, capped, injected into the system prompt as a hint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractSymbols, buildRepoMap, createRepoMapProvider, rankFiles } from '../src/agent/repomap.js';
import { createChat } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-map-'));
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { tools, harness };
}

const JS_SAMPLE = `import x from 'y';
export function alpha() { return 1; }
async function helper() {}
export class Widget {}
const arrowConst = () => 2;
function indented() {
  function nested() {}
}
export default function mainThing() {}
`;
const PY_SAMPLE = `import os
def top_level():
    pass

async def async_fn():
    pass

class Greeter:
    def method(self):
        pass
`;
const GO_SAMPLE = `package main
func Main() {}
func (s *Server) Handle() {}
`;
const RS_SAMPLE = `pub fn run() {}
struct Config {}
impl Config {
    fn new() -> Self {}
}
`;

test('repomap: symbol extraction across languages', () => {
  assert.deepEqual(extractSymbols('src/a.js', JS_SAMPLE), ['alpha', 'helper', 'Widget', 'arrowConst', 'indented', 'mainThing']);
  assert.deepEqual(extractSymbols('p/b.py', PY_SAMPLE), ['top_level', 'async_fn', 'Greeter']);
  assert.deepEqual(extractSymbols('m/c.go', GO_SAMPLE), ['Main', 'Handle']);
  assert.deepEqual(extractSymbols('m/d.rs', RS_SAMPLE), ['run', 'Config']);
  assert.deepEqual(extractSymbols('README.md', JS_SAMPLE), [], 'non-code files have no symbols');
  assert.deepEqual(extractSymbols('x.json', '{"a":1}'), []);
});

test('repomap: build on a real temp tree — paths, symbols, caps', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'alpha.js'), JS_SAMPLE);
  fs.writeFileSync(path.join(root, 'src', 'greeter.py'), PY_SAMPLE);
  fs.writeFileSync(path.join(root, 'README.md'), '# docs only');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const m = buildRepoMap(root, { churn: null });
  assert.ok(m.text.includes('src/alpha.js: alpha, helper, Widget, arrowConst, indented, mainThing'), m.text);
  assert.ok(m.text.includes('src/greeter.py: top_level, async_fn, Greeter'), m.text);
  assert.ok(!m.text.includes('nested'), 'nested functions are not mapped');
  assert.ok(!m.text.includes('README'), 'docs are not mapped');
  assert.ok(!m.text.includes('package.json'), 'non-code files are not mapped');
  assert.equal(m.files, 2);
  assert.equal(m.symbols, 9);
  assert.equal(m.truncated, false);
});

test('repomap: churn ranking puts hot files first; cap respects the budget', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const n of ['aaa.js', 'bbb.js', 'ccc.js']) {
    fs.writeFileSync(path.join(root, 'src', n), JS_SAMPLE);
  }
  const churn = new Map([['src/ccc.js', 12], ['src/bbb.js', 3]]);
  const m = buildRepoMap(root, { churn, maxChars: 400 });
  const iCcc = m.text.indexOf('src/ccc.js');
  const iBbb = m.text.indexOf('src/bbb.js');
  const iAaa = m.text.indexOf('src/aaa.js');
  assert.ok(iCcc !== -1 && iBbb !== -1 && iAaa !== -1);
  assert.ok(iCcc < iBbb && iBbb < iAaa, `churn order ccc(12) < bbb(3) < aaa(0), got ${m.text}`);
  // tiny budget → truncated flag and fewer files
  const tight = buildRepoMap(root, { churn, maxChars: 80 });
  assert.equal(tight.truncated, true);
  assert.ok(tight.files < m.files);
});

test('repomap: empty workspace → empty map (no section in the prompt)', () => {
  const root = tmpRoot();
  const m = buildRepoMap(root, { churn: null });
  assert.equal(m.text, '');
  assert.equal(m.files, 0);
});

test('repomap: injected into the system prompt as "## Repo map"; breakdown stays exact', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'alpha.js'), JS_SAMPLE);
  const { tools, harness } = makeBuddy(root);
  const provider = createRepoMapProvider(root, { maxChars: 2000 });
  const chat = createChat({
    router: { order: ['fake'], chat: async () => ({ text: '{"tool":"say","message":"x"}', model: 'fake', gateway: 'fake', latencyMs: 1 }) },
    tools,
    harness,
    repoMap: provider,
  });
  const sys = chat.contextBreakdown();
  assert.ok(sys.parts.repoMap > 0, 'the map has weight in the breakdown');
  const sum = Object.values(sys.parts).reduce((a, n) => a + n, 0);
  assert.equal(sum, sys.system, 'sections still sum EXACTLY to the system prompt');
  // the real check: a turn's system message carries the map
  const seen = [];
  const chat2 = createChat({
    router: { order: ['fake'], chat: async (messages) => { seen.push(messages); return { text: '{"tool":"say","message":"x"}', model: 'fake', gateway: 'fake', latencyMs: 1 }; } },
    tools,
    harness,
    repoMap: provider,
  });
  await chat2.turn('hi');
  const sysMsg = seen[0].find((m) => m.role === 'system');
  assert.match(sysMsg.content, /## Repo map/);
  assert.match(sysMsg.content, /src\/alpha\.js: alpha/);
  assert.match(sysMsg.content, /A hint, not the tree/);
});

test('repomap: disabled/empty map → no section, no weight', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const chat = createChat({
    router: { order: ['fake'], chat: async () => ({ text: '{"tool":"say","message":"x"}', model: 'fake', gateway: 'fake', latencyMs: 1 }) },
    tools,
    harness,
    repoMap: () => '',
  });
  const b = chat.contextBreakdown();
  assert.equal(b.parts.repoMap, 0);
  const sum = Object.values(b.parts).reduce((a, n) => a + n, 0);
  assert.equal(sum, b.system);
});

test('repomap: provider caches across calls, refresh() picks up new files', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'one.js'), 'function one() {}\n');
  const provider = createRepoMapProvider(root, { maxChars: 2000, ttlMs: 60_000 });
  const first = provider();
  assert.match(first, /src\/one\.js: one/);
  fs.writeFileSync(path.join(root, 'src', 'two.js'), 'function two() {}\n');
  assert.doesNotMatch(provider(), /two\.js/, 'cache serves the old map within the TTL');
  provider.refresh();
  assert.match(provider(), /src\/two\.js: two/, 'refresh() rescans');
});

test('repomap: rankFiles — churn desc then alphabetical, stable for ties', () => {
  const churn = new Map([['b.js', 5], ['c.js', 5]]);
  assert.deepEqual(rankFiles(['a.js', 'b.js', 'c.js', 'd.js'], churn), ['b.js', 'c.js', 'a.js', 'd.js']);
});
