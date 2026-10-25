import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalRepo } from '../src/tools/repo.js';
import { RepoEditor, MutationLedger, WRITE_DENYLIST } from '../src/tools/edit.js';

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-edit-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  return new LocalRepo(dir);
}

test('writeFile: create + rewrite with ledger', () => {
  const repo = tmpRepo();
  const ledger = new MutationLedger();
  const ed = new RepoEditor(repo, { ledger });
  const r1 = ed.writeFile('src/new.js', 'export const x = 1;\n', { reason: 'test' });
  assert.equal(r1.op, 'create');
  assert.equal(repo.readFile('src/new.js').content, 'export const x = 1;\n');
  const r2 = ed.writeFile('src/new.js', 'export const x = 2;\n', { reason: 'test' });
  assert.equal(r2.op, 'rewrite');
  assert.equal(ledger.filesChanged.length, 1);
  assert.ok(ledger.totalLines() >= 0);
  const md = ledger.toMarkdown();
  assert.match(md, /\| `src\/new\.js` \| create/);
});

test('replaceInFile: unique match required', () => {
  const repo = tmpRepo();
  const ed = new RepoEditor(repo, { ledger: new MutationLedger() });
  const r = ed.replaceInFile('src/app.js', 'a + b', 'a + b + 0', { reason: 'test' });
  assert.equal(r.op, 'replace');
  assert.match(repo.readFile('src/app.js').content, /a \+ b \+ 0/);

  assert.throws(() => ed.replaceInFile('src/app.js', 'NOPE_NOT_THERE', 'x'), /not found/);
  fs.writeFileSync(path.join(repo.root, 'src', 'dup.js'), 'alpha beta\nalpha gamma\n');
  assert.throws(() => ed.replaceInFile('src/dup.js', 'alpha', 'other'), /2 times/);
});

test('denylist: protected paths refuse to write', () => {
  const repo = tmpRepo();
  const ed = new RepoEditor(repo, { ledger: new MutationLedger(), denyPaths: WRITE_DENYLIST });
  for (const p of ['.github/workflows/ci.yml', 'src/.env', 'certs/server.pem', 'id_rsa.key', 'secrets.json', 'package-lock.json']) {
    assert.throws(() => ed.writeFile(p, 'evil'), RegExp(p.split('/').pop().replace('.', '\\.')), p);
  }
  // .git internals are denied too
  assert.throws(() => ed.writeFile('.git/config', 'evil'), /protected by policy/);
  // and normal files still work
  assert.doesNotThrow(() => ed.writeFile('src/ok.js', 'fine'));
});

test('path escape refused', () => {
  const repo = tmpRepo();
  const ed = new RepoEditor(repo, { ledger: new MutationLedger() });
  assert.throws(() => ed.writeFile('../outside.js', 'x'), /unsafe path/);
  assert.throws(() => ed.writeFile('/abs/path.js', 'x'), /unsafe path/);
  assert.throws(() => ed.writeFile('a/../../b.js', 'x'), /unsafe path|escapes/);
});

test('budgets: max files and max lines enforced', () => {
  const repo = tmpRepo();
  const ed = new RepoEditor(repo, { ledger: new MutationLedger(), maxFiles: 2, maxLines: 50 });
  ed.writeFile('src/a.js', 'a\n');
  ed.writeFile('src/b.js', 'b\n');
  assert.throws(() => ed.writeFile('src/c.js', 'c\n'), /file budget/);

  const repo2 = tmpRepo();
  const ed2 = new RepoEditor(repo2, { ledger: new MutationLedger(), maxFiles: 10, maxLines: 5 });
  assert.throws(() => ed2.writeFile('src/big.js', Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')), /line budget/);
});

test('appendToFile: appends and creates', () => {
  const repo = tmpRepo();
  const ed = new RepoEditor(repo, { ledger: new MutationLedger() });
  ed.appendToFile('README.md', 'extra line\n', { reason: 'test' });
  assert.match(repo.readFile('README.md').content, /# demo\nextra line/);
  ed.appendToFile('docs/new.md', 'hello\n');
  assert.equal(repo.readFile('docs/new.md').content, 'hello\n');
});

test('toTools: agent tool surface works end-to-end', async () => {
  const repo = tmpRepo();
  const ed = new RepoEditor(repo, { ledger: new MutationLedger() });
  const tools = ed.toTools(repo);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const read = await byName.read_file.run({ path: 'src/app.js' });
  assert.match(read, /export const add/);

  const write = await byName.write_file.run({ path: 'src/gen.js', content: 'const q = 1;\n' });
  assert.match(write, /OK create/);

  const replace = await byName.replace_in_file.run({ path: 'src/app.js', find: 'a + b', replace: 'b + a' });
  assert.match(replace, /OK replaced/);

  const denied = await byName.write_file.run({ path: '.github/workflows/x.yml', content: 'on: push' });
  assert.match(denied, /ERROR.*protected by policy/);
  // failed attempts are ledgered, never silent
  assert.ok(ed.ledger.entries.some((e) => e.op === 'failed' && e.path === '.github/workflows/x.yml'));

  const search = await byName.search_code.run({ needle: 'const q' });
  assert.match(search, /src\/gen\.js/);
});
