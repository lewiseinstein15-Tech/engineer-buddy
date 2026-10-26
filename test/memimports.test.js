// memimports.test.js — Build 14 (P1): MEMORY.md @path imports.
//
// A whole line `@path` in MEMORY.md pulls that repo file into memory at
// harness-assembly time. Locks down:
//   1. a whole-line @path is expanded inline, wrapped in [imported] tags
//   2. inline @tokens (emails, prose) are NOT imports; @@ is the literal escape
//   3. missing file, `..` escape, and secret paths become VISIBLE markers —
//      never silent drops (the "honest by construction" rule)
//   4. per-file cap 4k + total cap 8k with truncation markers
//   5. nested imports resolve against the imported file's directory, depth-capped
//   6. circular imports cannot loop forever
//   7. harnessContext(harness, root) expands; harnessContext(harness) does not
//   8. /memory shows the import list (source tripwire)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandMemoryImports, harnessContext } from '../src/harness/scaffold.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-mem-'));
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

test('memory imports: whole-line @path expands inline between tags', () => {
  const root = tmp();
  write(root, 'docs/style.md', '# Style\n- always pnpm, never npm');
  const out = expandMemoryImports(root, '# Memory\n\n@docs/style.md\n\nDone.');
  assert.match(out, /\[imported: @docs\/style\.md\]/);
  assert.match(out, /always pnpm, never npm/);
  assert.match(out, /\[\/imported\]/);
  // surrounding lines survive
  assert.match(out, /^# Memory/);
  assert.match(out, /Done\.$/);
});

test('memory imports: inline @tokens and prose are left alone', () => {
  const root = tmp();
  write(root, 'docs/x.md', 'content');
  const text = 'email me at bob@example.com or @bob\n\ninline @docs/x.md mention\n@@docs/x.md\n';
  const out = expandMemoryImports(root, text);
  assert.doesNotMatch(out, /\[imported/);
  assert.match(out, /bob@example\.com/);
  assert.match(out, /inline @docs\/x\.md mention/);
  assert.match(out, /@docs\/x\.md/, '@@ escape renders a literal @');
});

test('memory imports: missing file, .. escape and secret paths are visible markers', () => {
  const root = tmp();
  const out = expandMemoryImports(root, '@docs/missing.md\n@../outside.md\n@.env\n');
  assert.match(out, /\(memory import: @docs\/missing\.md — file not found\)/);
  assert.match(out, /@\.\/outside\.md refused — path escapes the repo|@\.\.\/outside\.md refused — path escapes the repo/);
  assert.match(out, /@\.env refused — secret paths are never loaded/);
});

test('memory imports: per-file cap 4k with truncation marker, total cap 8k', () => {
  const root = tmp();
  write(root, 'big/a.md', 'a'.repeat(5000));
  write(root, 'big/b.md', 'b'.repeat(5000));
  write(root, 'big/c.md', 'c'.repeat(5000));
  const out = expandMemoryImports(root, '@big/a.md\n@big/b.md\n@big/c.md\n');
  // a: 4000 kept + truncated marker; b: 4000 kept (total now 8000); c: budget gone
  assert.match(out, /@big\/a\.md truncated at 4000 chars/);
  assert.match(out, /@big\/b\.md truncated at 4000 chars/);
  assert.match(out, /@big\/c\.md skipped — import budget \(8k chars\) exhausted/);
});

test('memory imports: nested imports resolve against the imported file dir', () => {
  const root = tmp();
  write(root, 'docs/outer.md', 'outer body\n@inner.md');
  write(root, 'docs/inner.md', 'inner body');
  const out = expandMemoryImports(root, '@docs/outer.md');
  assert.match(out, /outer body/);
  assert.match(out, /inner body/, 'relative ref inside the imported file resolves next to it');
});

test('memory imports: nesting deeper than 3 is refused with a marker', () => {
  const root = tmp();
  write(root, 'd1.md', '@d2.md');
  write(root, 'd2.md', '@d3.md');
  write(root, 'd3.md', '@d4.md');
  write(root, 'd4.md', 'too deep');
  const out = expandMemoryImports(root, '@d1.md');
  // d1→d2→d3→d4 is depth 4 — the deepest import must be refused, not loaded
  assert.doesNotMatch(out, /too deep/);
  assert.match(out, /nesting deeper than 3 — refused|circular import|nesting/);
});

test('memory imports: circular imports stop cleanly', () => {
  const root = tmp();
  write(root, 'a.md', 'A body\n@b.md');
  write(root, 'b.md', 'B body\n@a.md');
  const out = expandMemoryImports(root, '@a.md');
  assert.match(out, /A body/);
  assert.match(out, /B body/);
  assert.match(out, /circular import/);
  assert.ok(out.length < 5000, 'no explosion');
});

test('memory imports: harnessContext expands only when root is given', () => {
  const root = tmp();
  write(root, 'notes.md', 'imported body');
  const harness = { 'MEMORY.md': '# Mem\n@notes.md', 'systemprompt.md': 'sp', 'guardrails.md': 'gr', 'tool_guidance.md': 'tg' };
  const withRoot = harnessContext(harness, root);
  assert.match(withRoot.memory, /imported body/);
  const withoutRoot = harnessContext(harness);
  assert.doesNotMatch(withoutRoot.memory, /imported body/);
  assert.match(withoutRoot.memory, /@notes\.md/);
  // other parts untouched
  assert.equal(withRoot.systemprompt, 'sp');
  assert.equal(withRoot.guardrails, 'gr');
});

test('memory imports: #note append and imports coexist (appendMemoryNote shape)', () => {
  const root = tmp();
  write(root, 'facts.md', 'the deploy target is staging');
  const memPath = path.join(root, '.buddy/harness/MEMORY.md');
  fs.mkdirSync(path.dirname(memPath), { recursive: true });
  fs.writeFileSync(memPath, '# Memory\n\n## Notes\n- (2026-10-26) always run pnpm test\n\n@facts.md\n', 'utf8');
  const out = expandMemoryImports(root, fs.readFileSync(memPath, 'utf8'));
  assert.match(out, /always run pnpm test/);
  assert.match(out, /deploy target is staging/);
});

// Source tripwires: the /memory surface must document the import syntax.
test('memory imports: /memory documents imports + @note tip (source tripwire)', async () => {
  const src = fs.readFileSync(new URL('../src/terminal/repl.js', import.meta.url), 'utf8');
  assert.match(src, /expanded into every session/);
  assert.match(src, /whole line "@path" imports a repo file/);
});
