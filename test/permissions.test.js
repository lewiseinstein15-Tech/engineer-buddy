// Permission rules engine + audit trail (v0.19.0): deny > allow > defaultMode,
// user → project settings merge, yolo only flips ask, domain rules for web
// tools, append-only .buddy/audit.jsonl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  globMatch,
  subjectFor,
  loadPermissions,
  evaluatePermission,
  matchingRule,
  auditTrail,
} from '../src/permissions.js';
import { createChat } from '../src/agent/chat.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-perms-'));
}

test('globMatch: * within segments, ** across, literal dots escaped', () => {
  assert.equal(globMatch('docs/**', 'docs/a/b.md'), true);
  assert.equal(globMatch('docs/**', 'docsx/a.md'), false);
  assert.equal(globMatch('src/*.js', 'src/a.js'), true);
  assert.equal(globMatch('src/*.js', 'src/sub/a.js'), false, '* does not cross /');
  assert.equal(globMatch('.env*', '.env.local'), true);
  assert.equal(globMatch('git *', 'git status'), true);
  assert.equal(globMatch('*', 'anything at all'), true);
});

test('subjectFor picks the right subject per tool family', () => {
  assert.equal(subjectFor('fs_write', { path: 'x.js' }), 'x.js');
  assert.equal(subjectFor('bash', { command: 'git status' }), 'git status');
  assert.equal(subjectFor('web_fetch', { url: 'https://github.com/a' }), 'https://github.com/a');
  assert.equal(subjectFor('unknown_tool', { a: 1 }), '{"a":1}');
});

test('evaluatePermission: deny beats allow beats defaultMode; yolo never overrides deny', () => {
  const perms = {
    defaultMode: 'ask',
    allow: ['Bash(git *)', 'fs_write(docs/**)'],
    deny: ['Bash(rm *)', 'fs_write(.env*)'],
  };
  assert.equal(evaluatePermission(perms, 'bash', { command: 'git status' }), 'allow');
  assert.equal(evaluatePermission(perms, 'bash', { command: 'rm -rf /' }), 'deny');
  assert.equal(evaluatePermission(perms, 'bash', { command: 'npm test' }), 'ask');
  assert.equal(evaluatePermission(perms, 'fs_write', { path: 'docs/guide.md' }), 'allow');
  assert.equal(evaluatePermission(perms, 'fs_write', { path: '.env.local' }), 'deny');
  // yolo flips ask → allow but NOT deny
  assert.equal(evaluatePermission(perms, 'bash', { command: 'npm test' }, { yolo: true }), 'allow');
  assert.equal(evaluatePermission(perms, 'bash', { command: 'rm -rf /' }, { yolo: true }), 'deny');
  assert.equal(evaluatePermission(null, 'bash', { command: 'x' }), 'ask', 'null perms = ask everywhere');
});

test('domain rules: exact + suffix match, subdomains included, strangers excluded', () => {
  const perms = { defaultMode: 'ask', allow: ['WebFetch(domain:github.com)'], deny: ['web_fetch(domain:evil.example)'] };
  assert.equal(evaluatePermission(perms, 'web_fetch', { url: 'https://github.com/foo/bar' }), 'allow');
  assert.equal(evaluatePermission(perms, 'web_fetch', { url: 'https://api.github.com/x' }), 'allow', 'subdomain matches');
  assert.equal(evaluatePermission(perms, 'web_fetch', { url: 'https://notgithub.com/x' }), 'ask', 'suffix tricks refused');
  assert.equal(evaluatePermission(perms, 'web_fetch', { url: 'https://evil.example/x' }), 'deny');
  assert.equal(evaluatePermission(perms, 'web_fetch', { url: 'https://sub.evil.example/x' }), 'deny');
});

test('bare Tool rule matches every call; tool names are case-insensitive', () => {
  const perms = { defaultMode: 'ask', allow: ['todo'] };
  assert.equal(evaluatePermission(perms, 'todo', { items: [] }), 'allow');
  const perms2 = { defaultMode: 'ask', deny: ['WebFetch'] };
  assert.equal(evaluatePermission(perms2, 'web_fetch', { url: 'https://x.example' }), 'deny');
});

test('loadPermissions merges user → project, warns on junk, never throws', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-home-'));
  fs.mkdirSync(path.join(home, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(home, '.buddy', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git *)'], deny: ['Bash(rm *)'] } }));
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'ask', allow: ['fs_read(src/**)'] } }));
  const { perms, warnings } = loadPermissions(root, { home });
  assert.deepEqual(perms.allow, ['Bash(git *)', 'fs_read(src/**)']);
  assert.deepEqual(perms.deny, ['Bash(rm *)']);
  assert.equal(perms.defaultMode, 'ask');
  assert.equal(warnings.length, 0);
  // junk project settings degrade to a warning, user rules still work
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), '{not json');
  const r2 = loadPermissions(root, { home });
  assert.equal(r2.warnings.length, 1);
  assert.deepEqual(r2.perms.allow, ['Bash(git *)']);
  assert.deepEqual(loadPermissions(tmpRoot(), { home: tmpRoot() }).perms.defaultMode, 'ask', 'absent settings = defaults');
});

test('matchingRule names the deciding rule (for refusals + audit rows)', () => {
  const perms = { deny: ['Bash(rm *)'], allow: [], defaultMode: 'ask' };
  assert.equal(matchingRule(perms, 'bash', { command: 'rm x' }, 'deny'), 'Bash(rm *)');
  assert.equal(matchingRule(perms, 'bash', { command: 'ls' }, 'deny'), null);
});

test('auditTrail appends JSONL; every tool call lands there', async () => {
  const root = tmpRoot();
  let step = 0;
  const chat = createChat({
    // step 1 → bash (approved), step 2 → say (ends the turn)
    router: {
      order: ['x'],
      chat: async () => {
        step += 1;
        return { text: step === 1 ? '{"tool":"bash","args":{"command":"echo hi"}}' : '{"tool":"say","message":"done"}' };
      },
    },
    tools: [
      { name: 'say', description: 'd', args: '{}', run: async ({ message }) => message },
      { name: 'bash', description: 'd', args: '{}', risky: true, run: async () => 'ran' },
    ],
    harness: '',
    root,
    permissions: { defaultMode: 'ask', allow: [], deny: ['Bash(rm *)'] },
    approval: async () => 'yes',
  });
  await chat.turn('do it');
  const file = path.join(root, '.buddy', 'audit.jsonl');
  assert.ok(fs.existsSync(file), 'audit file exists');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.length >= 2, `every tool call audited (${rows.length} rows)`);
  assert.ok(rows.every((r) => r.at && typeof r.tool === 'string' && 'verdict' in r), 'who/what/when/verdict shape');
  assert.ok(rows.some((r) => r.tool === 'bash' && r.verdict === 'ran'), 'approved call recorded as ran');
  // a denied call is recorded as refused
  const chat2 = createChat({
    router: { order: ['x'], chat: async () => ({ text: '{"tool":"bash","args":{"command":"rm x"}}' }) },
    tools: [{ name: 'bash', description: 'd', args: '{}', risky: true, run: async () => 'ran' }],
    harness: '',
    root,
    permissions: { defaultMode: 'ask', allow: [], deny: ['Bash(rm *)'] },
    approval: async () => 'yes',
  });
  await chat2.turn('try it');
  const rows2 = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const deniedRow = rows2.find((r) => r.tool === 'bash' && r.denied === true);
  assert.ok(deniedRow, 'deny-rule refusal audited');
});
