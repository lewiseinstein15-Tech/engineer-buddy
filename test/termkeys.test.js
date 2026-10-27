// termkeys.test.js — v0.33.0 /terminal-setup: detection table + instruction
// catalogs. The contract: every terminal id the detector can return has real
// steps, and the no-setup fallbacks always advertise what works TODAY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTerminal, setupSteps, NO_SETUP } from '../src/terminal/termkeys.js';

test('detectTerminal: the full detection table', () => {
  assert.equal(detectTerminal({ TERM_PROGRAM: 'iTerm.app' }).id, 'iterm');
  assert.equal(detectTerminal({ TERM_PROGRAM: 'vscode' }).id, 'vscode');
  assert.equal(detectTerminal({ TERM: 'xterm-ghostty' }).id, 'ghostty');
  assert.equal(detectTerminal({ TERM_PROGRAM: 'WezTerm' }).id, 'wezterm');
  assert.equal(detectTerminal({ TERM: 'alacritty' }).id, 'alacritty');
  assert.equal(detectTerminal({ TERM: 'xterm-kitty' }).id, 'kitty');
  assert.equal(detectTerminal({ TERM: 'foot' }).id, 'foot');
  assert.equal(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }).id, 'generic');
  assert.equal(detectTerminal({ TERM: 'screen-256color' }).id, 'generic');
  assert.equal(detectTerminal({}).id, 'generic');
});

test('detectTerminal: matched env is reported honestly', () => {
  const d = detectTerminal({ TERM_PROGRAM: 'iTerm.app' });
  assert.match(d.matched, /TERM_PROGRAM/);
});

test('setupSteps: every known terminal has concrete steps; unknown falls back', () => {
  for (const id of ['iterm', 'vscode', 'kitty', 'ghostty', 'wezterm', 'alacritty', 'foot', 'generic']) {
    const steps = setupSteps(id);
    assert.ok(Array.isArray(steps) && steps.length >= 1, `${id} has steps`);
    assert.ok(steps.every((s) => typeof s === 'string' && s.length > 0));
  }
  assert.equal(setupSteps('nope')[0], setupSteps('generic')[0]);
});

test('the vscode snippet is pasteable JSON and sends LF (\\u000a)', () => {
  const steps = setupSteps('vscode');
  assert.ok(steps.some((s) => s.includes('shift+enter')));
  assert.match(steps.join(' '), /\\u000a/);
});

test('NO_SETUP: fallbacks that work today are always advertised', () => {
  assert.ok(NO_SETUP.length >= 4);
  assert.ok(NO_SETUP.some((l) => l.includes('ctrl+j')));
  assert.ok(NO_SETUP.some((l) => l.includes('alt+enter')));
  assert.ok(NO_SETUP.some((l) => l.includes('\\')));
});
