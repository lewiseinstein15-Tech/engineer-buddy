// diffcommand.test.js — /diff: uncommitted changes without leaving the REPL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatDiffReport, SLASH_COMMANDS, SLASH_DESCRIPTIONS } from '../src/terminal/repl.js';

test('/diff: registered in the palette with a description', async () => {
  assert.ok(SLASH_COMMANDS.includes('diff'));
  assert.match(SLASH_DESCRIPTIONS.diff, /uncommitted changes/);
  const src = await readFile(new URL('../src/terminal/repl.js', import.meta.url), 'utf8');
  assert.match(src, /case 'diff': \{/, 'the handler exists');
  assert.match(src, /git status --short/, 'reads status');
  assert.match(src, /git diff HEAD --stat/, 'reads the stat');
  assert.match(src, /not a git repository — \/diff needs git/, 'degrades gracefully outside git');
});

test('/diff: clean tree → one quiet line', () => {
  const out = formatDiffReport({ status: '', stat: '', diff: '' });
  assert.match(out, /working tree clean/);
  assert.ok(out.length < 80);
});

test('/diff: changes → status, stat and a capped diff body', () => {
  const status = ' M src/app.js\n?? notes.md\n';
  const stat = ' src/app.js | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)';
  const diff = `diff --git a/src/app.js b/src/app.js\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n${'x'.repeat(8000)}`;
  const out = formatDiffReport({ status, stat, diff });
  assert.match(out, /Uncommitted changes/);
  assert.match(out, /M src\/app\.js/, 'status included');
  assert.match(out, /\?\? notes\.md/, 'untracked files visible');
  assert.match(out, /1 file changed/, 'stat included');
  assert.match(out, /diff --git/, 'the diff body is included');
  assert.ok(out.length < 6500, 'the diff body is capped (~6k chars)');
  assert.ok(out.includes('…'));
});

test('/diff: git failure surfaces the reason', () => {
  const out = formatDiffReport({ status: '', stat: '', diff: '', gitFailed: 'fatal: bad object HEAD' });
  assert.match(out, /git failed/);
  assert.match(out, /bad object HEAD/);
});
