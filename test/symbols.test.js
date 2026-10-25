// Symbol index + def→ref graph (v0.16.0) — symbol_search / go_to_def /
// find_refs / impact, zero-dep.
//
// The repo map shipped the map but deferred the def→reference graph to
// "the symbol index below" — this suite is that promise landing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractDefs,
  extractImports,
  findRefsIn,
  buildSymbolIndex,
  searchDefs,
  createSymbolIndexProvider,
} from '../src/agent/symbols.js';
import { buildLocalTools } from '../src/tools/local.js';
import { LocalScope } from '../src/tools/local.js';

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-sym-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'core.js'),
    [
      'import { helper } from "./util.js";',
      '',
      'export function makeWidget(opts) {',
      '  return helper(opts);',
      '}',
      '',
      'export class Widget {',
      '  spin() {}',
      '}',
      '',
      'function internalOnly() {}',
      '',
      'export const WIDGET_KINDS = ["spin"];',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(root, 'src', 'util.js'),
    ['export function helper(x) {', '  return x;', '}', 'export function helpCenter() { return helper(1); }'].join('\n')
  );
  fs.writeFileSync(path.join(root, 'src', 'consumer.js'), 'import { makeWidget } from "./core.js";\nimport { helper } from "./util.js";\nexport const w = makeWidget({});\n');
  fs.writeFileSync(path.join(root, 'test', 'core.test.js'), "import { test } from 'node:test';\nimport { makeWidget } from '../src/core.js';\ntest('widget', () => {});\n");
  return root;
}

const fileSet = (files) => new Set(files.map((f) => f.file));

test('extractDefs: functions, classes, methods-free but nested helpers, with lines', () => {
  const root = tmpRepo();
  const content = fs.readFileSync(path.join(root, 'src', 'core.js'), 'utf8');
  const defs = extractDefs('src/core.js', content);
  const names = defs.map((d) => d.name);
  assert.deepEqual(names, ['makeWidget', 'Widget', 'internalOnly']);
  assert.equal(defs[0].line, 3);
  assert.equal(defs[0].kind, 'function');
  assert.equal(defs[1].kind, 'class');
  assert.ok(defs[0].sig.includes('makeWidget'));
});

test('extractImports: relative specifiers resolve with extension + index fallback', () => {
  const root = tmpRepo();
  const files = ['src/core.js', 'src/util.js', 'src/consumer.js', 'test/core.test.js'];
  const set = new Set(files);
  const imps = extractImports('src/consumer.js', fs.readFileSync(path.join(root, 'src', 'consumer.js'), 'utf8'), set);
  assert.deepEqual(imps.sort(), ['src/core.js', 'src/util.js']);
  const testImps = extractImports('test/core.test.js', fs.readFileSync(path.join(root, 'test', 'core.test.js'), 'utf8'), set);
  assert.deepEqual(testImps, ['src/core.js']);
});

test('import graph: importers map is the reverse edge', () => {
  const root = tmpRepo();
  const idx = buildSymbolIndex(root);
  const importers = [...(idx.importers.get('src/core.js') || [])].sort();
  assert.deepEqual(importers, ['src/consumer.js', 'test/core.test.js']);
  assert.equal((idx.importers.get('src/does-not-exist.js') || new Set()).size, 0);
});

test('searchDefs: exact beats prefix beats substring', () => {
  const root = tmpRepo();
  const idx = buildSymbolIndex(root);
  const exact = searchDefs(idx.defs, 'helper');
  assert.equal(exact[0].name, 'helper');
  const prefix = searchDefs(idx.defs, 'help');
  assert.ok(prefix.some((d) => d.name === 'helper'));
  assert.ok(prefix.some((d) => d.name === 'helpCenter'));
  const sub = searchDefs(idx.defs, 'Widg');
  assert.ok(sub.every((d) => /widget/i.test(d.name)));
  assert.deepEqual(searchDefs(idx.defs, ''), []);
});

test('findRefsIn: word-boundary only, caps and truncation flag', () => {
  const root = tmpRepo();
  const files = ['src/core.js', 'src/util.js', 'src/consumer.js', 'test/core.test.js'];
  const { hits } = findRefsIn(files, root, 'makeWidget');
  const filesHit = [...new Set(hits.map((h) => h.file))];
  assert.ok(filesHit.includes('src/consumer.js'));
  assert.ok(filesHit.includes('test/core.test.js'));
  // word boundary: "makeWidgetly" must not match; "makeWidget" does
  fs.writeFileSync(path.join(root, 'src', 'noise.js'), 'const makeWidgetly = 1;\nmakeWidget();\n');
  const { hits: h2 } = findRefsIn([...files, 'src/noise.js'], root, 'makeWidget');
  assert.ok(h2.some((h) => h.file === 'src/noise.js' && h.line === 2));
  assert.ok(!h2.some((h) => h.text.includes('makeWidgetly') && !h.text.includes('makeWidget(')));
  // non-identifier needles are refused, not regex-explosions
  assert.deepEqual(findRefsIn(files, root, 'a(b)').hits, []);
});

test('tools registered: symbol_search / go_to_def / find_refs / impact answer correctly', async () => {
  const root = tmpRepo();
  const scope = new LocalScope(root);
  const tools2 = Object.fromEntries(buildLocalTools({ scope }).map((t) => [t.name, t]));
  assert.ok(tools2.symbol_search && tools2.go_to_def && tools2.find_refs && tools2.impact);

  assert.match(await tools2.symbol_search.run({ needle: 'makeWidget' }), /src\/core\.js:3 \[function\] makeWidget/);
  assert.match(await tools2.go_to_def.run({ symbol: 'internalOnly' }), /src\/core\.js:\d+ \[function\] internalOnly/);
  const refs = await tools2.find_refs.run({ symbol: 'makeWidget' });
  assert.match(refs, /references? across \d+ files?/);
  assert.match(refs, /src\/consumer\.js:3/);
  const impact = await tools2.impact.run({ symbol: 'makeWidget' });
  assert.match(impact, /imported by: .*consumer\.js/);
  assert.match(impact, /referenced in: .*test\/core\.test\.js/);
  assert.match(await tools2.go_to_def.run({ symbol: 'noSuchThing' }), /ERROR: no definition/);
  assert.match(await tools2.impact.run({ symbol: 'noSuchThing' }), /ERROR/);
});

test('provider caches and refreshes (TTL discipline like the repo map)', () => {
  const root = tmpRepo();
  const provider = createSymbolIndexProvider(root, { ttlMs: 50 });
  const first = provider();
  assert.ok(first.defs.length > 0);
  fs.writeFileSync(path.join(root, 'src', 'late.js'), 'export function laterAdded() {}\n');
  const cached = provider();
  assert.ok(!cached.defs.some((d) => d.name === 'laterAdded'), 'within TTL the cache holds');
  provider.refresh();
  assert.ok(provider().defs.some((d) => d.name === 'laterAdded'), 'refresh picks up new defs');
});

test('plan mode allowlist includes the navigation tools', () => {
  import('../src/tools/planmode.js').then(({ PLAN_TOOLS }) => {
    for (const t of ['symbol_search', 'go_to_def', 'find_refs', 'impact']) assert.ok(PLAN_TOOLS.has(t));
  });
});
