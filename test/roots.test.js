// Multi-root workspace (v0.26.0): /add-dir roots, alias addressing, guard
// inheritance, search/glob merging, and the settings persistence helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aliasFor,
  dedupeAlias,
  pickAlias,
  listConfiguredDirs,
  saveProjectDirs,
  addProjectDir,
  removeProjectDir,
  buildExtraRoots,
  MAX_EXTRA_ROOTS,
} from '../src/tools/roots.js';
import { LocalScope } from '../src/tools/local.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-roots-'));
}

// ── alias helpers ────────────────────────────────────────────────────────────

test('aliasFor: basename, sanitized, trailing slashes tolerated', () => {
  assert.equal(aliasFor('/home/z/My Project'), 'my-project');
  assert.equal(aliasFor('/srv/api/'), 'api');
  assert.equal(aliasFor('/srv/…weird!!name'), 'weird-name');
  assert.equal(aliasFor(''), 'dir');
  assert.equal(aliasFor('///'), 'dir');
  assert.ok(aliasFor('/x/' + 'a'.repeat(40)).length <= 24, 'capped at 24 chars');
});

test('dedupeAlias: first free with -2/-3 suffixes', () => {
  assert.equal(dedupeAlias('api', []), 'api');
  assert.equal(dedupeAlias('api', ['api']), 'api-2');
  assert.equal(dedupeAlias('api', new Set(['api', 'api-2'])), 'api-3');
});

test('pickAlias: skips mounted aliases AND names existing in the main workspace', () => {
  const main = tmp();
  fs.mkdirSync(path.join(main, 'sibling'));
  fs.mkdirSync(path.join(main, 'sibling-2'));
  const other = tmp();
  assert.equal(pickAlias('sibling', new Set(), main), 'sibling-3', 'main-root entries are avoided');
  assert.equal(pickAlias('fresh', new Set(['fresh']), main), 'fresh-2', 'mounted aliases are avoided');
  assert.equal(pickAlias('open', new Set(), main), 'open');
});

// ── LocalScope multi-root ────────────────────────────────────────────────────

function twoRoots() {
  const main = tmp();
  const other = tmp();
  fs.writeFileSync(path.join(main, 'app.js'), 'console.log("main");\n');
  fs.mkdirSync(path.join(main, 'src'));
  fs.writeFileSync(path.join(main, 'src', 'a.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(other, 'svc.js'), 'const b = 2;\n');
  fs.mkdirSync(path.join(other, 'lib'));
  fs.writeFileSync(path.join(other, 'lib', 'x.js'), 'const needleToken = 42;\n');
  return { main, other, scope: new LocalScope(main, [{ alias: 'other', path: other }]) };
}

test('LocalScope: extra roots mount and read/write/list work under alias/', () => {
  const { other, scope } = twoRoots();
  assert.equal(scope.extra.get('other').root, other);
  const r = scope.read('other/svc.js');
  assert.match(r.content, /const b = 2/);
  assert.deepEqual(scope.list('other'), ['lib/x.js', 'svc.js']);
  assert.deepEqual(scope.list('other/lib'), ['x.js'], 'listing an aliased subdir returns paths relative to it');
  // write + replace across the root
  const w = scope.write('other/generated.md', '# generated\n');
  assert.equal(w.op, 'create');
  assert.equal(fs.readFileSync(path.join(other, 'generated.md'), 'utf8'), '# generated\n');
  const rep = scope.replace('other/generated.md', 'generated', 'rewritten');
  assert.equal(rep.count, 1);
  assert.match(fs.readFileSync(path.join(other, 'generated.md'), 'utf8'), /rewritten/);
});

test('LocalScope: alias collisions and shadowing are refused; removeRoot unmounts', () => {
  const { main, other, scope } = twoRoots();
  assert.throws(() => scope.addRoot('other', main), /already a workspace root/);
  fs.mkdirSync(path.join(main, 'docs')); // exists in main → shadowing 'docs' refused
  assert.throws(() => scope.addRoot('docs', other), /already exists in the main workspace/);
  assert.throws(() => scope.addRoot('Bad Alias!', other), /bad alias/);
  assert.equal(scope.removeRoot('nope'), false);
  assert.equal(scope.removeRoot('other'), true);
  assert.throws(() => scope.read('other/svc.js'), /cannot read/);
});

test('LocalScope: guards hold inside extra roots (.., secrets, policy paths)', () => {
  const { scope } = twoRoots();
  assert.throws(() => scope.read('other/../app.js'), /unsafe path/);
  assert.throws(() => scope.read('other/.env'), /likely secrets/);
  fs.writeFileSync(path.join(scope.extra.get('other').root, 'creds.pem'), 'x');
  assert.throws(() => scope.read('other/creds.pem'), /likely secrets/);
  fs.mkdirSync(path.join(scope.extra.get('other').root, '.buddy', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(scope.extra.get('other').root, '.buddy', 'harness', 'MEMORY.md'), 'secret notes');
  assert.throws(() => scope.read('other/.buddy/harness/MEMORY.md'), /protected by policy/);
  fs.mkdirSync(path.join(scope.extra.get('other').root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(scope.extra.get('other').root, '.git', 'config'), '[core]');
  assert.throws(() => scope.read('other/.git/config'), /protected by policy/);
  // containment: a sub-path cannot escape the extra root either
  assert.throws(() => scope.write('other/../../../outside.txt', 'x'), /unsafe path/);
});

test('LocalScope: fs_search merges main + extra roots with alias prefixes', () => {
  const { scope } = twoRoots();
  const hits = scope.search('needleToken');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'other/lib/x.js', 'extra-root hit carries the alias prefix');
  const all = scope.search('const', { max: 20 });
  assert.ok(all.some((h) => h.file === 'src/a.js'), 'main-root hits stay unprefixed');
  assert.ok(all.some((h) => h.file === 'other/svc.js'), 'extra-root hits prefixed');
});

test('LocalScope: glob targets extra roots with alias/ prefix, merges plain patterns', () => {
  const { scope } = twoRoots();
  assert.deepEqual(scope.glob('other/**/*.js'), ['other/lib/x.js', 'other/svc.js']);
  const plain = scope.glob('**/*.js');
  assert.ok(plain.includes('src/a.js'));
  assert.ok(plain.includes('other/svc.js'));
  assert.deepEqual(scope.glob('other/lib/*.js'), ['other/lib/x.js']);
});

test('LocalScope: freshness guard works across roots; checkpoints skip extra roots', async () => {
  const { other, scope } = twoRoots();
  scope.read('other/svc.js');
  fs.writeFileSync(path.join(other, 'svc.js'), 'const b = 999;\n');
  assert.throws(() => scope.replace('other/svc.js', 'const b = 2;', 'x'), /changed since you last read it/);
  // write creates a fresh baseline → edit right after works
  scope.write('other/fresh.txt', 'v1');
  scope.replace('other/fresh.txt', 'v1', 'v2');
  assert.equal(fs.readFileSync(path.join(other, 'fresh.txt'), 'utf8'), 'v2');
  // no checkpoint dir appears in the MAIN root for extra-root writes
  scope.write('other/ck.txt', 'data');
  const main = scope.root;
  const ckDir = path.join(main, '.buddy', 'checkpoints');
  if (fs.existsSync(ckDir)) {
    const names = fs.readdirSync(ckDir).join(',');
    assert.ok(!names.includes('ck.txt'), 'extra-root files are not checkpointed into the main root');
  }
});

test('LocalScope: rootsInfo lists aliases; absent when none mounted', () => {
  const bare = new LocalScope(tmp());
  assert.equal(bare.rootsInfo(), '');
  const { scope } = twoRoots();
  assert.match(scope.rootsInfo(), /other\/ → /);
  assert.match(scope.rootsInfo(), /<alias>\/relative\/path/);
});

// ── settings persistence ─────────────────────────────────────────────────────

test('saveProjectDirs preserves other permissions keys and hooks; add/remove idempotent', () => {
  const root = tmp();
  const buddy = path.join(root, '.buddy');
  fs.mkdirSync(buddy, { recursive: true });
  fs.writeFileSync(
    path.join(buddy, 'settings.json'),
    JSON.stringify({ chat: { theme: 'dark' }, permissions: { allow: ['Bash(git *)'], additionalDirectories: [] }, hooks: { PreToolUse: [{ command: 'echo hi' }] } }),
    'utf8'
  );
  const a = tmp();
  saveProjectDirs(root, [a]);
  const saved = JSON.parse(fs.readFileSync(path.join(buddy, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.permissions.additionalDirectories, [a]);
  assert.deepEqual(saved.permissions.allow, ['Bash(git *)'], 'allow rules survive');
  assert.equal(saved.chat.theme, 'dark', 'chat block survives');
  assert.ok(saved.hooks.PreToolUse, 'hooks survive');
  addProjectDir(root, a); // idempotent
  assert.equal(listConfiguredDirs(root).project.length, 1);
  const b = tmp();
  addProjectDir(root, b);
  assert.equal(listConfiguredDirs(root).project.length, 2);
  const { removed } = removeProjectDir(root, a);
  assert.equal(removed, true);
  assert.deepEqual(listConfiguredDirs(root).project, [b]);
});

test('buildExtraRoots: merges user+project, resolves relative, skips missing dirs, caps', () => {
  const root = tmp();
  const home = tmp();
  const realA = tmp();
  fs.mkdirSync(path.join(home, '.buddy'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.buddy', 'settings.json'),
    JSON.stringify({ permissions: { additionalDirectories: [realA] } }),
    'utf8'
  );
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.buddy', 'settings.json'),
    JSON.stringify({ permissions: { additionalDirectories: ['/definitely/missing/dir', root] } }),
    'utf8'
  );
  const roots = buildExtraRoots(root, null, { home });
  assert.equal(roots.length, 2, 'missing dir skipped, root itself refused? no — it exists');
  assert.ok(roots.some((r) => r.path === realA));
  assert.ok(roots.every((r) => /^[a-z0-9_-]{1,24}$/.test(r.alias)), 'aliases are tool-safe');
  // dedupe: same basename twice → -2
  const same1 = tmp();
  const same2 = tmp();
  const dupRoots = buildExtraRoots(root, [same1, same2]);
  const names = dupRoots.map((r) => r.alias);
  assert.equal(new Set(names).size, names.length, 'aliases never collide');
  // cap
  const many = Array.from({ length: 12 }, () => tmp());
  assert.equal(buildExtraRoots(root, many).length, MAX_EXTRA_ROOTS);
});
