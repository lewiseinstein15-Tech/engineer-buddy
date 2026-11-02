// Tests for the computer tool: registry shape, combo parsing, honest
// degradation without a display server, screenshot path containment, and the
// recovery-teaching path-guard errors (--add-dir / settings mount wave).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildComputerTool, parseCombo } from '../src/tools/computer.js';
import { LocalScope } from '../src/tools/local.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-computer-'));
}

test('parseCombo: mods normalize to mac words, junk is null', () => {
  assert.deepEqual(parseCombo('ctrl+shift+t'), { mods: ['control', 'shift'], key: 't' });
  assert.deepEqual(parseCombo('cmd+c'), { mods: ['command'], key: 'c' });
  assert.deepEqual(parseCombo('enter'), { mods: [], key: 'enter' });
  assert.equal(parseCombo('ctrl+***'), null);
  assert.equal(parseCombo(''), null);
});

test('computer tool: shape matches the house tool contract', () => {
  const t = buildComputerTool({ scope: null });
  assert.equal(t.name, 'computer');
  assert.equal(t.risky, true); // desktop actions ride the approval gate
  assert.match(t.description, /screenshot/);
  assert.equal(t.render({ action: 'click', x: 12, y: 34 }), 'computer click 12,34');
});

test('computer tool: without a display every action degrades honestly', async () => {
  const old = { DISPLAY: process.env.DISPLAY, WAYLAND: process.env.WAYLAND_DISPLAY };
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  try {
    const t = buildComputerTool({ scope: null });
    for (const a of [{ action: 'screenshot', path: 's.png' }, { action: 'click', x: 1, y: 2 }, { action: 'type', text: 'x' }, { action: 'key', keys: 'ctrl+s' }]) {
      const r = await t.run(a);
      assert.match(r, /no display server/);
      assert.match(r, /browser tool/); // names the headless alternative
    }
  } finally {
    if (old.DISPLAY) process.env.DISPLAY = old.DISPLAY;
    if (old.WAYLAND) process.env.WAYLAND_DISPLAY = old.WAYLAND;
  }
});

test('computer tool: screenshot path must be .png and stay inside the workspace', async () => {
  const root = tmpRoot();
  const scope = new LocalScope(root);
  const t = buildComputerTool({ scope });
  const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const r1 = await t.run({ action: 'screenshot', path: 'shot.jpg' });
  assert.match(r1, /must end \.png/);
  const r2 = await t.run({ action: 'screenshot', path: '../escape.png' });
  assert.match(r2, /(escapes|unsafe|no display server)/);
  if (noDisplay) {
    // containment assert above cannot run without a display — resolveSafe check is unit-level here
    assert.throws(() => scope.resolveSafe('../escape.png'));
  }
  assert.throws(() => scope.resolveSafe('../escape.png'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('path guard: UNSAFE_PATH and PATH_ESCAPE errors teach all three recoveries', () => {
  const root = tmpRoot();
  const scope = new LocalScope(root);
  assert.throws(() => scope._guard('../up.txt'), /unsafe path[\s\S]*--add-dir[\s\S]*additionalDirectories/);
  assert.throws(() => scope.resolveSafe('../../out.txt'), /path escapes root[\s\S]*--add-dir[\s\S]*additionalDirectories/);
  fs.rmSync(root, { recursive: true, force: true });
});
