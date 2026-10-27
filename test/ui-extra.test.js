import { test } from 'node:test';
import assert from 'node:assert/strict';
import { box, renderTodo, renderTable, renderToolCall, renderToolEvent, formatMs, logoBanner, renderObservation } from '../src/terminal/ui.js';
import { appendMemoryNote } from '../src/terminal/repl.js';
import { loadHarness, ensureHarness } from '../src/harness/scaffold.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('box: wraps rows with rounded corners', () => {
  const out = box(['hello', 'world'], {});
  assert.match(out, /╭/);
  assert.match(out, /╯/);
  assert.match(out, /hello/);
  assert.match(out, /world/);
  const lines = out.split('\n');
  assert.ok(lines.every((l) => l.length === lines[1].length || l.startsWith('  ╭') || l.startsWith('  ╰')));
});

test('renderTodo: status icons and done strikethrough text', () => {
  const out = renderTodo([
    { text: 'read files', status: 'done' },
    { text: 'patch bug', status: 'in_progress' },
    { text: 'run tests', status: 'pending' },
    { text: 'weird', status: 'bogus' },
  ]);
  assert.match(out, /✓ read files/);
  assert.match(out, /▸ patch bug/);
  assert.match(out, /○ run tests/);
  assert.match(out, /○ weird/); // unknown status falls back to pending
});

test('renderTable: aligns columns and shows headers', () => {
  const out = renderTable(
    [
      ['kilo', 'primary', 'fast'],
      ['llm7', 'backup', 'slower'],
    ],
    { headers: ['name', 'role', 'speed'] }
  );
  assert.match(out, /name/);
  assert.match(out, /─/); // separator line
  const lines = out.split('\n');
  assert.equal(lines.length, 4); // headers + sep + 2 rows
});

test('renderToolCall: shows tool and arg text, denial in red path', () => {
  assert.match(renderToolCall({ tool: 'bash', argText: 'npm test' }), /bash/);
  assert.match(renderToolCall({ tool: 'bash', argText: 'npm test' }), /npm test/);
  assert.match(renderToolCall({ tool: 'fs_write', denied: true }), /denied/);
});

test('renderToolEvent: card includes preview and observation', () => {
  const out = renderToolEvent({ tool: 'fs_replace', args: {}, observation: 'OK replaced', preview: '  │ + new line' });
  assert.match(out, /fs_replace/);
  assert.match(out, /\+ new line/);
  assert.match(out, /OK replaced/);
});

test('renderObservation: caps lines and reports the remainder (v0.33 policy: tail kept)', () => {
  const many = Array.from({ length: 12 }, (_, i) => `L${i}`).join('\n');
  const out = renderObservation(many, { maxLines: 3 });
  assert.match(out, /L0/);            // head kept
  assert.match(out, /L11/);           // v0.33: the TAIL stays visible (verdicts live there)
  assert.match(out, /\+8 hidden lines/);
  assert.match(out, /tail is kept/);
  assert.match(renderObservation(''), /no output/);
});

test('formatMs: human durations', () => {
  assert.equal(formatMs(850), '850ms');
  assert.equal(formatMs(4200), '4.2s');
  assert.equal(formatMs(66000), '1m06s');
});

test('logoBanner: contains identity + tips', () => {
  const out = logoBanner('9.9.9', { root: '/w', brain: 'kilo', harnessDir: '/w/.buddy/harness', sessions: 2, git: 'main' });
  assert.match(out, /Buddy Code/);
  assert.match(out, /9\.9\.9/);
  assert.match(out, /kilo/);
  assert.match(out, /main/);
  assert.match(out, /Ctrl\+C/);
});

test('appendMemoryNote: creates, appends under ## Notes, and seeds missing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-mem-'));
  ensureHarness(root);
  const p1 = appendMemoryNote(root, 'always run pnpm test');
  const mem1 = loadHarness(root)['MEMORY.md'];
  assert.match(mem1, /## Notes/);
  assert.match(mem1, /\(.*\) always run pnpm test/);

  appendMemoryNote(root, 'second note');
  const mem2 = loadHarness(root)['MEMORY.md'];
  const notesIdx = mem2.indexOf('## Notes');
  const next = mem2.indexOf('##', notesIdx + 1);
  const section = mem2.slice(notesIdx, next === -1 ? undefined : next);
  assert.match(section, /always run pnpm test/);
  assert.match(section, /second note/);
  assert.equal(p1, path.join(root, '.buddy/harness/MEMORY.md'));

  // A memory file without a Notes section gets one.
  const memPath = path.join(root, '.buddy/harness/MEMORY.md');
  fs.writeFileSync(memPath, '# Memory\n\n## Build & test\n- npm test\n', 'utf8');
  appendMemoryNote(root, 'third note');
  const mem3 = fs.readFileSync(memPath, 'utf8');
  assert.match(mem3, /## Build & test/);
  assert.match(mem3, /third note/);
  assert.ok(mem3.indexOf('## Build & test') < mem3.indexOf('third note'));
});
