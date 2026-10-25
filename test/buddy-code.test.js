import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRecorder, listSessions, loadSession, resumeMessages } from '../src/session.js';
import { parseSlash, SLASH_COMMANDS } from '../src/terminal/repl.js';

test('SessionRecorder: JSONL roundtrip keeps user/say pairs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-sess-'));
  const rec = new SessionRecorder(root, 'first task');
  rec.append({ type: 'user', text: 'first task' });
  rec.append({ type: 'tool', tool: 'fs_read', args: { path: 'a.js' }, observation: 'x' });
  rec.append({ type: 'say', text: 'done with task one' });
  rec.append({ type: 'user', text: 'second task' });
  rec.append({ type: 'say', text: 'done again' });

  const sess = loadSession(rec.path);
  assert.equal(sess.pairs.length, 2);
  assert.deepEqual(sess.pairs[0], { user: 'first task', buddy: 'done with task one' });
  assert.deepEqual(sess.pairs[1], { user: 'second task', buddy: 'done again' });

  const msgs = resumeMessages(sess);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0].role, 'user');
  assert.match(msgs[1].content, /done with task one/);
});

test('listSessions: newest first, empty when missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-sess-'));
  assert.deepEqual(listSessions(root), []);
  const a = new SessionRecorder(root, 'alpha task');
  const b = new SessionRecorder(root, 'beta task');
  const list = listSessions(root);
  assert.equal(list.length, 2);
  assert.ok(list[0].endsWith(path.basename(b.file))); // sorted desc by timestamped name
  assert.ok(list[1].endsWith(path.basename(a.file)));
});

test('parseSlash: commands parse; plain input returns null', () => {
  assert.deepEqual(parseSlash('/help'), { name: 'help', args: '' });
  assert.deepEqual(parseSlash('  /YOLO '), { name: 'yolo', args: '' });
  assert.deepEqual(parseSlash('/resume 20261025'), { name: 'resume', args: '20261025' });
  assert.equal(parseSlash('fix the login bug'), null);
  assert.equal(parseSlash(''), null);
  assert.deepEqual(parseSlash('/'), { name: '', args: '' });
  for (const name of ['help', 'new', 'tools', 'memory', 'experience', 'yolo', 'learn', 'sessions', 'resume', 'status', 'quit']) {
    assert.ok(SLASH_COMMANDS.includes(name), name);
  }
});
