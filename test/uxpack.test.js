// UX & narration pack (v0.22.0): /verbosity levels, /theme palettes,
// /output-style system-prompt swap, /statusline template, shared settings file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProjectSettings, updateProjectSetting, loadSettingsView, setChatSetting, getChatSetting } from '../src/settings.js';
import { setTheme, currentTheme, themeNames } from '../src/terminal/ui.js';
import { listOutputStyles, loadOutputStyle } from '../src/harness/outputstyles.js';
import { renderStatusline } from '../src/terminal/repl.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ux-'));
}

// ── settings.js: the shared file survives consumers ──────────────────────────

test('updateProjectSetting deep-merges — UI tweaks never wipe hooks/permissions', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.buddy', 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: 'echo hi' }, permissions: { deny: ['Bash(rm *)'] } })
  );
  setChatSetting(root, 'verbosity', 'silent');
  setChatSetting(root, 'theme', 'mono');
  const raw = JSON.parse(fs.readFileSync(path.join(root, '.buddy', 'settings.json'), 'utf8'));
  assert.equal(raw.hooks.SessionStart, 'echo hi', 'hooks preserved');
  assert.deepEqual(raw.permissions.deny, ['Bash(rm *)'], 'permissions preserved');
  assert.equal(raw.chat.verbosity, 'silent');
  assert.equal(raw.chat.theme, 'mono');
});

test('settings view: user under project, project wins, absent = defaults', () => {
  const root = tmpRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-home-'));
  fs.mkdirSync(path.join(home, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(home, '.buddy', 'settings.json'), JSON.stringify({ chat: { verbosity: 'verbose', theme: 'dark' } }));
  assert.equal(getChatSetting(root, 'verbosity', 'summary', { home }), 'verbose', 'user value flows through');
  setChatSetting(root, 'verbosity', 'silent');
  assert.equal(getChatSetting(root, 'verbosity', 'summary', { home }), 'silent', 'project overrides user');
  assert.equal(getChatSetting(tmpRoot(), 'theme', null), null, 'absent → fallback');
  const view = loadSettingsView(tmpRoot(), { home });
  assert.deepEqual(view.chat.theme, 'dark');
});

test('junk settings degrade to {} — never throws', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), '{{{not json');
  assert.deepEqual(readProjectSettings(root), {});
  const r = updateProjectSetting(root, { chat: { verbosity: 'verbose' } });
  assert.equal(r.chat.verbosity, 'verbose', 'junk replaced by the merge');
});

// ── themes ────────────────────────────────────────────────────────────────────

test('themes: names, switch, invalid refused, current tracks', () => {
  assert.deepEqual(themeNames(), ['dark', 'light', 'high-contrast', 'mono']);
  assert.equal(currentTheme(), 'dark');
  assert.equal(setTheme('mono'), 'mono');
  assert.equal(currentTheme(), 'mono');
  // mono: painters are identity even where color would apply
  
  assert.equal(setTheme('high-contrast'), 'high-contrast');
  assert.equal(setTheme('nope'), null, 'unknown refused');
  assert.equal(currentTheme(), 'high-contrast', 'failed switch does not clobber');
  assert.equal(setTheme('dark'), 'dark');
  assert.equal(currentTheme(), 'dark');
});

// ── output styles ─────────────────────────────────────────────────────────────

test('output styles: list layers (project wins), load with frontmatter stripped', () => {
  const root = tmpRoot();
  const dir = path.join(root, '.buddy', 'harness', 'output-styles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'socratic.md'), '---\ndescription: Ask before telling\n---\nYou are a Socratic engineer. Never give answers directly; ask leading questions.');
  fs.writeFileSync(path.join(dir, 'changelog.md'), '# Changelog mode\nOnly write release notes.');
  const styles = listOutputStyles(root);
  assert.ok(styles.some((s) => s.name === 'socratic' && s.source === 'project' && /Ask before telling/.test(s.description)));
  const loaded = loadOutputStyle(root, 'socratic');
  assert.equal(loaded.source, 'project');
  assert.match(loaded.body, /^You are a Socratic engineer/);
  assert.ok(!loaded.body.includes('---'), 'frontmatter stripped');
  assert.equal(loadOutputStyle(root, 'missing-style'), null);
  assert.equal(loadOutputStyle(root, 'default'), null, 'default = no override');
});

// ── statusline ────────────────────────────────────────────────────────────────

test('renderStatusline: placeholders filled, missing dropped, whitespace squeezed, off = empty', () => {
  const ctx = { branch: 'main', gateway: 'kilo', ctx: '5.9k', session: 'fix-auth', todo: '2/5', cwd: 'engineer-buddy' };
  assert.equal(renderStatusline('{branch} · {gateway} · {ctx} ctx', ctx), 'main · kilo · 5.9k ctx');
  assert.equal(renderStatusline('{branch}|{todo}|{session}', { branch: 'main' }), 'main||');
  assert.equal(renderStatusline('{branch}   {ctx}', { branch: 'dev', ctx: '1k' }), 'dev 1k');
  assert.equal(renderStatusline('', ctx), '');
  assert.equal(renderStatusline(null, ctx), '');
  assert.equal(renderStatusline('{branch}', {}), '');
});
