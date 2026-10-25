// queued.test.js — P1: messages typed while Buddy works are QUEUED, not
// refused; they run in order when the turn ends; Ctrl+C clears the queue.
//
// startRepl needs a real TTY, so like repl.test.js these lock the wiring down
// at source level (the v0.8.1 tripwire style).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SRC = await readFile(new URL('../src/terminal/repl.js', import.meta.url), 'utf8');

test('queue: busy tasks are queued, not refused', () => {
  const busy = SRC.slice(SRC.indexOf('async function runTask'));
  const guard = busy.slice(0, busy.indexOf('busy = true;'));
  assert.match(guard, /msgQueue\.push/, 'the busy branch pushes to the queue');
  assert.match(guard, /⌁ queued/, 'and tells the user it queued');
  assert.doesNotMatch(guard, /one task at a time/, 'the old refusal is gone');
});

test('queue: the drain loop runs queued tasks after the turn, in order', () => {
  const body = SRC.slice(SRC.indexOf('while (current) {'), SRC.indexOf('} finally {\n      aborter = null;'));
  assert.ok(body.length > 0, 'the turn loop exists');
  assert.match(body, /msgQueue\.shift\(\)/, 'each iteration takes the next queued task');
  assert.match(body, /running queued task/, 'and announces it');
});

test('queue: interrupt clears the queue (stop = stop everything)', () => {
  assert.match(SRC, /out\?\.aborted && msgQueue\.length/, 'abort is checked against the queue');
  assert.match(SRC, /queue cleared/, 'with a visible note');
});

test('queue: the busy footer shows the queue depth', () => {
  assert.match(SRC, /\$\{msgQueue\.length\} queued/, 'tool-event busy label carries the suffix');
  assert.match(SRC, /I'll run it when this turn ends/, 'the queue note explains when it runs');
});

test('queue: /help documents the behavior', () => {
  assert.match(SRC, /messages queue and run in order next/);
  assert.match(SRC, /interrupt the running task \(drops queued messages\)/);
});
