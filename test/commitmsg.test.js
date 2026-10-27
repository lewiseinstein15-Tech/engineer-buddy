// commitmsg.test.js — v0.36.0 the deterministic commit-message drafter
// (checklist §9 "generated commit messages from the diff" + the trailer).
// Pure halves: classification, scope inference, hunk-header contexts, the
// draft shape, and the Co-Authored-By trailer contract.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyChange, inferScope, hunkContexts, diffShape,
  draftCommitMessage, coAuthorTrailer, withTrailer, DEFAULT_COAUTHOR,
} from '../src/tools/commitmsg.js';

describe('classifyChange', () => {
  const f = (path, extra = {}) => ({ path, ...extra }); // flags: isNew/isDeleted; counts: add/del

  test('test files only → test', () => {
    assert.equal(classifyChange([f('test/fmt.test.js'), f('src/x.test.js')]).type, 'test');
  });
  test('docs only → docs', () => {
    assert.equal(classifyChange([f('README.md'), f('docs/guide.mdx')]).type, 'docs');
  });
  test('lockfiles only → chore(deps)', () => {
    const c = classifyChange([f('package-lock.json'), f('yarn.lock')]);
    assert.equal(c.type, 'chore');
    assert.equal(c.scope, 'deps');
  });
  test('code + its tests → fix (the regression-test shape)', () => {
    assert.equal(classifyChange([f('src/fmt.js'), f('fmt.test.js')]).type, 'fix');
  });
  test('new source files → feat', () => {
    assert.equal(classifyChange([f('src/newthing.js', { isNew: true }), f('src/old.js')]).type, 'feat');
  });
  test('existing source only → refactor', () => {
    assert.equal(classifyChange([f('src/a.js'), f('src/b.py')]).type, 'refactor');
  });
  test('CI config only → ci', () => {
    assert.equal(classifyChange([f('.github/workflows/ci.yml'), f('.gitlab-ci.yml')]).type, 'ci');
  });
  test('empty → chore (honest fallback)', () => {
    assert.equal(classifyChange([]).type, 'chore');
  });
});

describe('inferScope', () => {
  test('the dominant top-level dir wins', () => {
    assert.equal(inferScope([{ path: 'src/a.js' }, { path: 'src/b.js' }, { path: 'README.md' }]), 'src');
  });
  test('src/<sub> is used when src alone says nothing', () => {
    assert.equal(inferScope([{ path: 'src/terminal/repl.js' }, { path: 'src/terminal/ui.js' }]), 'src/terminal');
  });
  test('repo-root files carry no scope', () => {
    assert.equal(inferScope([{ path: 'README.md' }]), '');
  });
});

describe('hunkContexts', () => {
  test('pulls the enclosing function names git embeds, in order, deduped (modifier keywords stripped)', () => {
    const diff = [
      'diff --git a/src/fmt.js b/src/fmt.js',
      '@@ -12,7 +12,9 @@ export function slugify(input) {',
      '+  const words = input.trim()',
      '@@ -21,4 +23,6 @@ export function initials(name) {',
      '+  return w[0]',
      '@@ -30,2 +34,4 @@ export function slugify(input) {',
      '+  more',
    ].join('\n');
    assert.deepEqual(hunkContexts(diff), ['function slugify(input)', 'function initials(name)']);
  });
  test('no context in the header → empty', () => {
    assert.deepEqual(hunkContexts('@@ -1,2 +1,3 @@\n+x'), []);
  });
});

describe('diffShape', () => {
  test('counts +/- lines, skipping the file headers', () => {
    const d = ['--- a/x', '+++ b/x', '+one', '+two', '-gone', ' context'].join('\n');
    assert.deepEqual(diffShape(d), { added: 2, deleted: 1 });
  });
});

describe('draftCommitMessage', () => {
  test('a code+test fix drafts fix(scope): fix <fn> with file-group body', () => {
    const files = [
      { path: 'src/fmt.js', add: 3, del: 1 },
      { path: 'fmt.test.js', add: 8, del: 0, isNew: true },
    ];
    const diff = [
      'diff --git a/src/fmt.js b/src/fmt.js',
      '@@ -10,7 +10,9 @@ export function slugify(input) {',
      '+    .trim()',
    ].join('\n');
    const d = draftCommitMessage({ diff, files });
    assert.match(d.title, /^fix(\([^)]*\))?: fix slugify/);
    assert.match(d.body, /changed: src\/fmt\.js/);
    assert.match(d.body, /new: fmt\.test\.js|changed: fmt\.test\.js/);
    assert.match(d.body, /\+\d+\/-\d+/);
    assert.match(d.body, /drafted from the staged diff/);
  });
  test('lockfile-only changes → chore(deps)', () => {
    const d = draftCommitMessage({ diff: '+stuff', files: [{ path: 'package-lock.json', add: 20, del: 4 }] });
    assert.match(d.title, /^chore\(deps\):/);
  });
  test('the title never exceeds 72 chars', () => {
    const files = [{ path: 'src/very/long/path/that/goes/on/and/on/element.js', add: 1, del: 0 }];
    const d = draftCommitMessage({ diff: '+x', files });
    assert.ok(d.title.length <= 72, `title too long: ${d.title}`);
  });
});

describe('the Co-Authored-By trailer', () => {
  test('default trailer names Buddy', () => {
    assert.match(coAuthorTrailer({}), /^Co-Authored-By: Buddy </);
    assert.match(coAuthorTrailer({}), new RegExp(DEFAULT_COAUTHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
  test('BUDDY_COAUTHOR overrides it', () => {
    assert.equal(coAuthorTrailer({ BUDDY_COAUTHOR: 'Lewis <lewis@x.dev>' }), 'Co-Authored-By: Lewis <lewis@x.dev>');
  });
  test('BUDDY_NO_COAUTHOR opts out', () => {
    assert.equal(coAuthorTrailer({ BUDDY_NO_COAUTHOR: '1' }), '');
    assert.equal(coAuthorTrailer({ BUDDY_NO_COAUTHOR: '0' }), coAuthorTrailer({})); // '0' is NOT opt-out
  });
  test('withTrailer appends once and never duplicates', () => {
    const once = withTrailer('subject body', {});
    assert.match(once, /subject body\n\nCo-Authored-By: /);
    const twice = withTrailer(once, {});
    assert.equal(twice.match(/Co-Authored-By:/g).length, 1);
  });
  test('withTrailer respects an explicit co-author already in the body', () => {
    const b = 'body\n\nCo-Authored-By: Someone <s@x.dev>';
    assert.equal(withTrailer(b, {}), b);
  });
  test('opt-out + empty body → empty string (no trailer lines at all)', () => {
    assert.equal(withTrailer('', { BUDDY_NO_COAUTHOR: '1' }), '');
  });
});
