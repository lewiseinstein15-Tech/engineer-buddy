import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRecorder, sessionInfo, exportMarkdown, writeExport } from '../src/session.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-export-'));
}

test('sessionInfo: first task, turn count, mtime', () => {
  const root = tmpRoot();
  const rec = new SessionRecorder(root, 'fix the login bug');
  rec.append({ type: 'user', text: 'fix the login bug' });
  rec.append({ type: 'tool', tool: 'fs_read', args: { path: 'a.js' }, observation: 'x' });
  rec.append({ type: 'say', text: 'fixed it' });
  rec.append({ type: 'user', text: 'now add tests' });
  rec.append({ type: 'say', text: 'tests added' });
  const info = sessionInfo(rec.path);
  assert.equal(info.firstUser, 'fix the login bug');
  assert.equal(info.turns, 2);
  assert.ok(info.mtime);
  assert.ok(info.name.endsWith('.jsonl'));
});

test('exportMarkdown: transcript with turns, replies, and tool tallies', () => {
  const root = tmpRoot();
  const rec = new SessionRecorder(root, 'fix the bug');
  rec.append({ type: 'user', text: 'fix the bug' });
  rec.append({ type: 'tool', tool: 'fs_read', args: { path: 'a.js' }, observation: 'x' });
  rec.append({ type: 'tool', tool: 'fs_read', args: { path: 'b.js' }, observation: 'y' });
  rec.append({ type: 'tool', tool: 'fs_replace', args: { path: 'a.js' }, observation: 'OK' });
  rec.append({ type: 'say', text: 'Fixed. All tests pass.\nSecond line.' });
  const md = exportMarkdown(rec.path, { workspace: '/work/demo' });
  assert.match(md, /# Buddy Code transcript/);
  assert.match(md, /\/work\/demo/);
  assert.match(md, /## Turn 1/);
  assert.match(md, /\*\*You:\*\* fix the bug/);
  assert.match(md, /\*\*Buddy:\*\* Fixed\. All tests pass\./);
  assert.match(md, /3 tool calls: fs_read×2, fs_replace/);
});

test('writeExport: writes markdown next to .buddy/exports/', () => {
  const root = tmpRoot();
  const rec = new SessionRecorder(root, 'export me');
  rec.append({ type: 'user', text: 'export me' });
  rec.append({ type: 'say', text: 'done' });
  const out = writeExport(root, rec.path, { workspace: root });
  assert.ok(out.startsWith(path.join(root, '.buddy', 'exports')));
  assert.ok(out.endsWith('.md'));
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /export me/);
  assert.match(md, /done/);
});

test('loadSession: skips corrupt lines instead of crashing', async () => {
  const { loadSession } = await import('../src/session.js');
  const root = tmpRoot();
  const rec = new SessionRecorder(root, 'robustness');
  rec.append({ type: 'user', text: 'robustness' });
  fs.appendFileSync(rec.path, '{not json at all\n', 'utf8');
  rec.append({ type: 'say', text: 'still works' });
  const sess = loadSession(rec.path);
  assert.equal(sess.pairs.length, 1);
  assert.equal(sess.pairs[0].buddy, 'still works');
});
