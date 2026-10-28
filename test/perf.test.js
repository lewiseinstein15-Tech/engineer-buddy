// perf tool (v0.40.0) — profilers with a structured summary, zero-dep.
//
// parser units pinned on canned profiler output; the command validator is the
// honesty surface (npm wrappers and shell soup are refused with the REASON);
// live runs are exercised against real node/python entries in a tmp root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseProfProcess,
  parsePstatsJson,
  parseSpeedscope,
  validatePerfCommand,
  createPerfTool,
} from '../src/tools/perf.js';

const PROF_TEXT = `[Summary]:
   samples  1000
   metadata ...

[JavaScript]:
   ticks  total  nonlib   name
    450   45.0%   46.9%  LazyCompile: *hotLoop /tmp/hot.js:5:1
    100   10.0%   10.4%  Stub: StringAdd

[C++]:
   ticks  total  nonlib   name
     50    5.0%    5.2%  memcpy
[Summary]:
   samples  1000
`;

test('parseProfProcess: summary total + merged JS/C++ hotspots, sorted by ticks', () => {
  const p = parseProfProcess(PROF_TEXT);
  assert.equal(p.total, 1000);
  assert.equal(p.hotspots.length, 3);
  assert.equal(p.hotspots[0].ticks, 450);
  assert.equal(p.hotspots[0].pct, 45.0);
  assert.match(p.hotspots[0].label, /hotLoop/);
  assert.equal(p.hotspots[2].label, 'memcpy');
});

test('parseProfProcess: empty/garbage input degrades to empty, never throws', () => {
  for (const bad of ['', null, undefined, 'not a profile at all']) {
    const p = parseProfProcess(bad);
    assert.deepEqual(p, { total: 0, hotspots: [] });
  }
});

test('parsePstatsJson: cumtime ranking with share of total', () => {
  const p = parsePstatsJson(JSON.stringify({
    total_tt: 2.0,
    top: [
      { f: 'hot.py:5 burn', nc: 10, ct: 1.5 },
      { f: '{method \'sleep\'}', nc: 10, ct: 0.5 },
    ],
  }));
  assert.equal(p.total, 2.0);
  assert.equal(p.hotspots[0].pct, 75.0);
  assert.match(p.hotspots[0].label, /burn/);
  assert.match(p.hotspots[1].label, /10 calls/);
});

test('parseSpeedscope: frame weights aggregated across samples', () => {
  const p = parseSpeedscope({
    shared: { frames: [{ name: 'main' }, { name: 'hotLoop' }, { name: 'sleep' }] },
    profiles: [{ type: 'sampled', samples: [[0, 1], [0, 1], [0, 2]], weights: [1, 1, 1] }],
  });
  assert.equal(p.total, 6);
  assert.equal(p.hotspots[0].label, 'main');
  assert.equal(p.hotspots[1].label, 'hotLoop');
  assert.equal(p.hotspots[1].ticks, 2);
});

test('validatePerfCommand: node/python entries pass, shell soup and wrappers refuse with the reason', () => {
  assert.equal(validatePerfCommand('node hot.js').lang, 'node');
  assert.equal(validatePerfCommand('python3 -m app').lang, 'python');
  for (const bad of ['npm test', 'node a.js && rm b', 'python x.py | tee out', 'make test', '', 'node a.js > out']) {
    const v = validatePerfCommand(bad);
    assert.equal(v.ok, false, `expected refusal: ${bad}`);
    assert.ok(v.error && v.error.length > 20, 'refusal must carry a reason');
  }
});

test('live node profile: real --prof run yields hotspots and keeps the V8 log in .buddy/perf', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-perf-'));
  fs.writeFileSync(path.join(root, 'hot.js'), `
function loop() { let s = 0; for (let i = 0; i < 3e7; i++) s += i % 7; return s; }
function main() { loop(); loop(); }
main();
`);
  const tool = createPerfTool({ root });
  const out = await tool.run({ command: 'node hot.js' });
  assert.match(out, /profiled `node hot\.js`/);
  assert.match(out, /top hotspots/);
  assert.match(out, /hotLoop|loop|main/);
  assert.match(out, /\.buddy\/perf\//);
  const kept = fs.readdirSync(path.join(root, '.buddy', 'perf'));
  assert.ok(kept.some((f) => f.includes('isolate-')), 'the V8 log is kept, not left in the repo root');
  assert.equal(fs.readdirSync(root).filter((f) => f.startsWith('isolate-')).length, 0, 'no isolate log litter in the repo root');
});

test('live python profile: cProfile ranks the hot function', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-perfpy-'));
  fs.writeFileSync(path.join(root, 'hot.py'), `
def burn():
    s = 0
    for i in range(600000):
        s += i % 7
    return s
burn()
`);
  const tool = createPerfTool({ root });
  const out = await tool.run({ command: 'python3 hot.py' });
  assert.match(out, /profiled `python3 hot\.py`/);
  assert.match(out, /top hotspots/);
  assert.match(out, /burn|hot\.py/);
});
