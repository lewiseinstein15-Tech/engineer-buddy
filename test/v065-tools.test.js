// Tests for the v0.65 tools wave: fs_edit alias (model muscle memory) and
// fs_read line paging (big files must not die at the 30k char cap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { ensureHarness } from '../src/harness/scaffold.js';

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  return { scope, tools };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v065-'));
}

function toolNamed(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} must be registered`);
  return t;
}

test('fs_edit: alias of fs_replace — same contract, really edits', async () => {
  const root = tmpRoot();
  const { tools } = makeBuddy(root);
  const edit = toolNamed(tools, 'fs_edit');
  fs.writeFileSync(path.join(root, 'app.js'), 'const name = "old";\nexport default name;\n');
  const r = await edit.run({ path: 'app.js', find: '"old"', replace: '"new"' });
  assert.match(r, /OK replaced snippet in app\.js/);
  assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'const name = "new";\nexport default name;\n');
  const rAll = await edit.run({ path: 'app.js', find: 'name', replace: 'handle', replace_all: true });
  assert.match(rAll, /OK replaced 2 occurrences/);
});

test('fs_read paging: offset/limit window a big file, default read unchanged', async () => {
  const root = tmpRoot();
  const { tools } = makeBuddy(root);
  const read = toolNamed(tools, 'fs_read');
  const lines = Array.from({ length: 120 }, (_, i) => `line-${i + 1}`);
  fs.writeFileSync(path.join(root, 'big.txt'), lines.join('\n') + '\n');

  const full = await read.run({ path: 'big.txt' });
  assert.match(full, /^FILE big\.txt:/); // legacy shape intact
  assert.match(full, /line-120/);

  const page = await read.run({ path: 'big.txt', offset: 50, limit: 10 });
  assert.match(page, /FILE big\.txt \[lines 50-59 of 120\]/);
  assert.match(page, /line-50\n/);
  assert.match(page, /line-59/);
  assert.doesNotMatch(page, /line-60\n/);
  assert.match(page, /MORE LINES EXIST: continue with offset 60/);

  const tail = await read.run({ path: 'big.txt', offset: 118, limit: 10 });
  assert.match(tail, /lines 118-120 of 120/);
  assert.doesNotMatch(tail, /MORE LINES/);

  const past = await read.run({ path: 'big.txt', offset: 500, limit: 10 });
  assert.match(past, /has 120 lines — offset 500 is past the end/);
});
