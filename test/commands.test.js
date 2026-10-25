import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, helpMarkdown, DEFAULT_HANDLE } from '../src/commands.js';

test('parseCommand: fix variants', () => {
  for (const body of ['@engineer-buddy fix #42', '@engineer-buddy fix issue #42', '@engineer-buddy try #7', '@engineer-buddy patch #3']) {
    const r = parseCommand(body);
    assert.equal(r.skill, 'fix', body);
    assert.ok(r.issue > 0, body);
  }
  assert.equal(parseCommand('@engineer-buddy fix #42').issue, 42);
  assert.equal(parseCommand('@Engineer-Buddy FIX #9').issue, 9); // case-insensitive
});

test('parseCommand: review / audit / notes / triage / help', () => {
  assert.equal(parseCommand('@engineer-buddy review').skill, 'review');
  assert.equal(parseCommand('@engineer-buddy re-review').skill, 'review');
  assert.equal(parseCommand('@engineer-buddy audit deps').skill, 'audit');
  assert.equal(parseCommand('@engineer-buddy notes').skill, 'notes');
  assert.equal(parseCommand('@engineer-buddy notes --since v1.2.0').since, 'v1.2.0');
  assert.equal(parseCommand('@engineer-buddy release notes').skill, 'notes');
  assert.equal(parseCommand('@engineer-buddy triage').skill, 'triage');
  assert.equal(parseCommand('@engineer-buddy help').skill, 'help');
});

test('parseCommand: unknown + non-commands', () => {
  const r = parseCommand('@engineer-buddy dance for me');
  assert.equal(r.skill, 'unknown');
  assert.match(r.unknown, /dance/);
  assert.equal(parseCommand('hey buddy fix #1'), null); // no handle → ignore
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand(null), null);
  assert.equal(parseCommand('@someone-else fix #1'), null);
});

test('helpMarkdown lists every command', () => {
  const md = helpMarkdown(DEFAULT_HANDLE);
  for (const cmd of ['review', 'fix #12', 'audit', 'notes', 'triage', 'help']) {
    assert.ok(md.includes(cmd), `missing ${cmd}`);
  }
});
