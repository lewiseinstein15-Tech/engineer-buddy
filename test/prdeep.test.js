// prdeep.test.js — v0.61.0 "the PR is context" (the capability audit's gap
// #5: PR deep integration). The pure halves offline: the sanitizer (whole
// ANSI/OSC sequences, controls dropped), the named caps, the one-call sync
// renderer, mergeable honesty, reply validation (teaching refusals, ZERO
// client calls), the GitHub reply client method (write never retried), the
// GitLab degradation, the tool-def hardening (hostile getters, junk ops),
// and the FACTS-NOT-CONTENT contract on the events log.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sanitizePrText, mergeableText, prFileRows, formatPrFiles, formatPrSync,
  PRSYNC_MAX_FILES, PRSYNC_PATCH_CHARS, REPLY_BODY_MAX,
  ghOp, buildGhTool, GH_OPS, organizeComments,
} from '../src/tools/ghapi.js';
import { GitHubClient } from '../src/tools/github.js';

const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-pr61-'));
const eventsOf = (root) => {
  const f = path.join(root, '.buddy', 'events.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

// ── the sanitizer: remote content is DATA, never machinery ──────────────────

describe('sanitizePrText', () => {
  test('complete CSI/OSC sequences go as wholes, controls drop, \\t\\n survive', () => {
    assert.equal(sanitizePrText('\u001b[2Jplain'), 'plain');
    assert.equal(sanitizePrText('\u001b]0;title\u0007body'), 'body');
    assert.equal(sanitizePrText('a\rb\u0000c\u007Fd'), 'abcd');
    assert.equal(sanitizePrText('keep\ttabs\nand lines'), 'keep\ttabs\nand lines');
    assert.equal(sanitizePrText(null), '');
    assert.equal(sanitizePrText(undefined), '');
  });
  test('the v0.55 lesson: an UNTERMINATED sequence swallows to the end — its body never paints', () => {
    assert.equal(sanitizePrText('ok \u001b[31'), 'ok ');
    assert.equal(sanitizePrText('ok \u001b]0;pwned'), 'ok ');
    assert.equal(sanitizePrText('\u001b[31mRED\u001b[0m tail'), 'RED tail');
  });
  test('hard cap bounds memory (a 1MB hostile body is cut)', () => {
    const out = sanitizePrText('x'.repeat(300000), { max: 1000 });
    assert.equal(out.length, 1000);
  });
});

// ── mergeable: data as the forge reports it, never a guess ──────────────────

describe('mergeableText', () => {
  test('github true/false/null shapes, gitlab merge_status, junk → unknown', () => {
    assert.equal(mergeableText({ mergeable: true }, 'github'), 'mergeable:true');
    assert.equal(mergeableText({ mergeable: false }, 'github'), 'mergeable:false');
    assert.match(mergeableText({ mergeable: null }, 'github'), /unknown.*computing/);
    assert.match(mergeableText({}, 'github'), /unknown/);
    assert.equal(mergeableText({ merge_status: 'can_be_merged' }, 'gitlab'), 'mergeable:true');
    assert.equal(mergeableText({ merge_status: 'cannot_be_merged' }, 'gitlab'), 'mergeable:false');
    assert.equal(mergeableText({ merge_status: 'checking' }, 'gitlab'), 'mergeable:checking');
    assert.equal(mergeableText(null, 'github'), /unknown/.test('unknown') ? mergeableText(null, 'github') : '');
    assert.match(mergeableText(null, 'github'), /unknown/);
  });
});

// ── file rows + the NAMED caps ──────────────────────────────────────────────

describe('prFileRows + formatPrFiles — caps fire and name themselves', () => {
  const mk = (n, patchLen = 50) => Array.from({ length: n }, (_, i) => ({
    filename: `src/f${i}.js`, status: 'modified', additions: 1, deletions: 0, patch: 'p'.repeat(patchLen),
  }));

  test('20 files → 12 shown + a NAMED +N-more marker; capped flag rides', () => {
    const rows = prFileRows(mk(20));
    const v = formatPrFiles(rows);
    assert.equal(v.total, 20);
    assert.equal(v.shown, PRSYNC_MAX_FILES);
    assert.equal(v.capped, true);
    assert.match(v.lines.at(-1), /\(\+8 more files — capped at 12/);
  });
  test('patch truncation is NAMED, never silent', () => {
    const v = formatPrFiles(prFileRows(mk(1, PRSYNC_PATCH_CHARS + 500)));
    assert.match(v.lines.join('\n'), /patch truncated at 2000 chars — read the file for the rest/);
  });
  test('hostile filename/patch bytes are sanitized at the row boundary', () => {
    const rows = prFileRows([{ filename: 'x\u001b[31my.js', status: 'added', additions: 'junk', deletions: null, patch: 'a\u0000b\r\u001b[2Jc' }]);
    assert.equal(rows[0].filename, 'xy.js');
    assert.equal(rows[0].additions, 0);
    assert.equal(rows[0].patch, 'abc');
  });
  test('junk entries (null, strings, numbers) become honest drops; no patch → the binary note', () => {
    assert.equal(prFileRows(null).length, 0);
    assert.equal(prFileRows([null, 'x', 42, {}]).length, 1);
    const v = formatPrFiles(prFileRows([{ filename: 'bin.png', status: 'added', additions: 0, deletions: 0 }]));
    assert.match(v.lines.join('\n'), /no patch data/);
  });
});

// ── the one-call picture (pure renderer) ────────────────────────────────────

describe('formatPrSync — the whole PR in one observation', () => {
  const row = { number: 7, title: 'fix: guard', branch: 'fix/x', base: 'main', author: 'alice', draft: false, url: 'https://x/7', at: new Date().toISOString() };
  const org = organizeComments([
    { id: 101, user: { login: 'bob' }, body: 'guard the empty case', path: 'src/x.js', line: 12, created_at: 'x' },
    { id: 102, user: { login: 'al' }, body: 'on it', in_reply_to_id: 101, path: 'src/x.js', line: 12, created_at: 'x' },
  ], 'github');

  test('meta + head sha + mergeable + files census + threads with ids + CI', () => {
    const out = formatPrSync({
      row, sha: '3f2a9bc123', mergeable: 'mergeable:true', provider: 'github', repo: 'a/b',
      files: prFileRows([{ filename: 'src/x.js', status: 'modified', additions: 4, deletions: 1, patch: '@@ -1 +1 @@' }]),
      threads: org.groups, general: org.general, bodies: [{ user: { login: 'dave' }, state: 'CHANGES_REQUESTED', body: 'needs the guard' }],
      checks: [{ name: 'CI · #47', state: 'success', url: 'u', at: new Date().toISOString() }],
    });
    assert.match(out, /#7 fix: guard/);
    assert.match(out, /fix\/x → main · by alice/);
    assert.match(out, /head 3f2a9bc · mergeable:true/);
    assert.match(out, /files: 1 · \+4\/−1 \(1 shown\)/);
    assert.match(out, /#101 @bob \(L12\): guard the empty case/);
    assert.match(out, /└ #102 @al: on it/);
    assert.match(out, /@dave · CHANGES_REQUESTED: needs the guard/);
    assert.match(out, /CI ✓ CI · #47 · success/);
  });
  test('honest zeros: no threads, no CI, mergeable unknown', () => {
    const out = formatPrSync({ row, sha: '', mergeable: 'mergeable:unknown (the forge is still computing — re-sync later)', provider: 'github', repo: 'a/b', files: [], threads: [], general: [], bodies: [], checks: [] });
    assert.match(out, /REVIEW THREADS: none yet/);
    assert.match(out, /CI on fix\/x: no runs found/);
    assert.match(out, /files: 0/);
    assert.match(out, /head \? · mergeable:unknown.*computing/);
  });
  test('GitLab degradation is NAMED (meta + threads + CI; no diff view)', () => {
    const out = formatPrSync({ row, sha: 'abc1234', mergeable: 'mergeable:true', provider: 'gitlab', repo: 'g/p', files: null, threads: org.groups, general: [], bodies: [], checks: [] });
    assert.match(out, /files: not fetched \(GitLab diffs API not wired/);
    assert.match(out, /named non-goal this wave/);
  });
  test('hostile comment bodies are sanitized at render (zero control bytes, ids still ride)', () => {
    const hostile = organizeComments([
      { id: 201, user: { login: 'eve' }, body: '\u001b[2J\u001b]0;p\u0007forged\r\u001b[31mRED\u001b[0m \u001b[3', path: 'src/x.js', line: 1, created_at: 'x' },
    ], 'github');
    const out = formatPrSync({ row, sha: 'a', mergeable: 'm', provider: 'github', repo: 'a/b', files: [], threads: hostile.groups, general: [], bodies: [], checks: [] });
    assert.doesNotMatch(out, /[\u0000-\u0008\u000B-\u001F\u007F]/);
    assert.match(out, /#201 @eve/);
    assert.match(out, /RED/);
    assert.doesNotMatch(out, /p\u0007/);
  });
});

// ── pr_reply validation: teaching refusals, ZERO client calls ───────────────

describe('pr_reply — writes refuse honestly before the wire', () => {
  const calls = [];
  const fakeClient = new Proxy({}, {
    get: (t, k) => {
      if (k === 'replyToReview') return async (...a) => { calls.push(a); return { id: 9901, in_reply_to_id: a[1] }; };
      return async () => { calls.push(k); return null; };
    },
  });
  const base = { provider: 'github', client: fakeClient, owner: 'a', repo: 'a/b' };
  const run = (args) => ghOp('/r', 'pr_reply', args, { getRemote: () => ({ ok: true, out: 'https://github.com/a/b.git' }), env: { BUDDY_GITHUB_TOKEN: 't' }, resolveGhOverride: null, __inject: null, ...{}, gh: base });

  test('junk pr / junk inReplyTo / empty body / over-cap body → teaching refusals', async () => {
    const cases = [
      [{ pr: Number.NaN, inReplyTo: 101, body: 'x' }, /pr_reply needs \{"pr": <number>\}/],
      [{ pr: -3, inReplyTo: 101, body: 'x' }, /pr_reply needs \{"pr": <number>\}/],
      [{ pr: 7.5, inReplyTo: 101, body: 'x' }, /pr_reply needs \{"pr": <number>\}/],
      [{ pr: 7 }, /inReplyTo/],
      [{ pr: 7, inReplyTo: 0, body: 'x' }, /inReplyTo/],
      [{ pr: 7, inReplyTo: 101 }, /non-empty/],
      [{ pr: 7, inReplyTo: 101, body: '   ' }, /non-empty/],
      [{ pr: 7, inReplyTo: 101, body: 'x'.repeat(REPLY_BODY_MAX + 1) }, /reply cap/],
      [{ pr: 7, inReplyTo: 101, body: 'ok', extra: null }, null],
    ];
    for (const [args, re] of cases) {
      calls.length = 0;
      const out = await ghOp('/r', 'pr_reply', args, { env: { BUDDY_GITHUB_TOKEN: 't' }, getRemote: () => ({ ok: true, out: 'https://github.com/a/b.git' }), __fakeClient: base, ...({}) });
      if (re) {
        assert.match(out, re);
        assert.equal(calls.length, 0, `junk args must never reach the wire: ${JSON.stringify(args).slice(0, 60)}`);
      }
    }
  });
});

// ── ghOp against a stubbed fetch: the sync + reply wire shapes ──────────────

describe('ghOp pr_sync/pr_reply over a stubbed global fetch (the v0.35 test pattern)', () => {
  const PULL = { number: 7, title: 't', state: 'open', draft: false, mergeable: true, user: { login: 'a' }, html_url: 'u', updated_at: '2026-10-30T10:00:00Z', head: { ref: 'f', sha: '3f2a9bc1234567890' }, base: { ref: 'main' } };
  const FILES = [{ filename: 'a.js', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@' }];
  const COMMENTS = [{ id: 101, user: { login: 'b' }, body: 'fix it', path: 'a.js', line: 3, created_at: 'x' }];
  const RUNS = { workflow_runs: [{ name: 'CI', run_number: 1, status: 'completed', conclusion: 'success', head_branch: 'f', created_at: 'x', html_url: 'u' }] };
  const repliesSeen = [];

  function stubFetch() {
    const orig = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      seen.push(`${opts.method || 'GET'} ${u.replace('https://api.github.com', '')}`);
      const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'content-type': 'application/json' } });
      if (u.endsWith('/pulls/7')) return json(200, PULL);
      if (u.includes('/pulls/7/files')) return json(200, FILES);
      if (u.includes('/comments/101/replies')) { repliesSeen.push(JSON.parse(opts.body)); return json(201, { id: 9901, in_reply_to_id: 101 }); }
      if (u.includes('/pulls/7/reviews')) return json(200, []);
      if (u.includes('/actions/runs')) return json(200, RUNS);
      if (u.includes('/pulls/7/comments')) return json(200, COMMENTS);
      return json(404, { message: 'Not Found' });
    };
    return { restore: () => { globalThis.fetch = orig; }, seen };
  }

  test('pr_sync: one call, five wire GETs, observation + counts-only fact row', async () => {
    const root = mkRoot();
    const { restore, seen } = stubFetch();
    try {
      const out = await ghOp('/r', 'pr_sync', { pr: 7 }, {
        env: { BUDDY_GITHUB_TOKEN: 'tok' },
        getRemote: () => ({ ok: true, out: 'https://github.com/a/b.git' }),
        eventsRoot: root,
      });
      assert.match(out, /#7 t/);
      assert.match(out, /head 3f2a9bc · mergeable:true/);
      assert.match(out, /#101 @b \(L3\): fix it/);
      const gets = seen.filter((s) => s.startsWith('GET'));
      assert.equal(gets.length, 5, `five wire GETs: ${JSON.stringify(seen)}`);
      const evs = eventsOf(root).filter((e) => e.type === 'prSync');
      assert.equal(evs.length, 1);
      assert.equal(evs[0].files, 1);
      assert.equal(evs[0].threads, 1);
      assert.equal(evs[0].checks, 1);
      assert.equal(JSON.stringify(evs[0]).includes('fix it'), false, 'fact rows carry counts, never content');
    } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('pr_reply: POST body shape, the new id in the observation, counts-only fact row', async () => {
    const root = mkRoot();
    const { restore } = stubFetch();
    try {
      const out = await ghOp('/r', 'pr_reply', { pr: 7, inReplyTo: 101, body: 'done in 3f2a9bc' }, {
        env: { BUDDY_GITHUB_TOKEN: 'tok' },
        getRemote: () => ({ ok: true, out: 'https://github.com/a/b.git' }),
        eventsRoot: root,
      });
      assert.match(out, /replied to review thread 101 .* new comment id 9901/);
      assert.deepEqual(repliesSeen.at(-1), { body: 'done in 3f2a9bc' });
      const evs = eventsOf(root).filter((e) => e.type === 'prReply');
      assert.equal(evs.length, 1);
      assert.equal(evs[0].inReplyTo, 101);
      assert.equal(evs[0].bodyChars, 'done in 3f2a9bc'.length);
      assert.equal(JSON.stringify(evs[0]).includes('done in 3f2a9bc'), false);
    } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('pr_reply on GitLab: the teaching refusal, zero wire calls', async () => {
    const { restore, seen } = stubFetch();
    try {
      const out = await ghOp('/r', 'pr_reply', { pr: 3, inReplyTo: 9, body: 'x' }, {
        env: { BUDDY_GITLAB_TOKEN: 'gl' },
        getRemote: () => ({ ok: true, out: 'https://gitlab.com/g/p.git' }),
      });
      assert.match(out, /discussions API \(not supported yet\)/);
      assert.equal(seen.length, 0);
    } finally { restore(); }
  });

  test('missing PR / junk args fire ZERO wire calls and teach', async () => {
    const { restore, seen } = stubFetch();
    try {
      const nf = await ghOp('/r', 'pr_sync', { pr: 999 }, { env: { BUDDY_GITHUB_TOKEN: 'tok' }, getRemote: () => ({ ok: true, out: 'https://github.com/a/b.git' }) });
      assert.match(nf, /HTTP 404/);
      const junk1 = await ghOp('/r', 'pr_sync', { pr: Number.NaN }, { env: { BUDDY_GITHUB_TOKEN: 'tok' }, getRemote: () => ({ ok: true, out: 'https://github.com/a/b.git' }) });
      assert.match(junk1, /pr_sync needs/);
      const junk2 = await ghOp('/r', 'pr_sync', {}, { env: { BUDDY_GITHUB_TOKEN: 'tok' }, getRemote: () => ({ ok: true, out: 'https://github.com/a/b.git' }) });
      assert.match(junk2, /pr_sync needs/);
      const wireAfterJunk = seen.filter((s) => s.startsWith('GET')).length;
      assert.equal(wireAfterJunk, 1, `only the 999 probe hit the wire — the two junk args fired ZERO calls (${wireAfterJunk} GETs)`);
    } finally { restore(); }
  });
});

// ── the client method: writes never auto-retry ──────────────────────────────

describe('GitHubClient.replyToReview', () => {
  test('POSTs the right path + body; a network error fails fast (no retry, no double-post)', async () => {
    const orig = globalThis.fetch;
    const posts = [];
    globalThis.fetch = async (url, opts = {}) => {
      if (opts.method === 'POST') {
        posts.push({ url: String(url), body: opts.body });
        if (posts.length === 1) throw new Error('wire blip');
      }
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    };
    try {
      const c = new GitHubClient({ token: 't', repo: 'a/b' });
      await assert.rejects(() => c.replyToReview(7, 101, 'x'), /network error/);
      assert.equal(posts.length, 1, `a WRITE fails fast — exactly one attempt (${posts.length})`);
      assert.equal(posts[0].url, 'https://api.github.com/repos/a/b/pulls/7/comments/101/replies');
      assert.deepEqual(JSON.parse(posts[0].body), { body: 'x' });
    } finally { globalThis.fetch = orig; }
  });
});

// ── the tool def: hostile args can never break narration or gating ──────────

describe('buildGhTool hardening (the v0.59 getter-safe discipline, carried)', () => {
  const t = buildGhTool({ root: '/r', env: {} });
  test('new ops teach in the description/args; riskyWhen splits reads from writes', () => {
    assert.match(t.description, /pr_sync/);
    assert.match(t.description, /pr_reply/);
    for (const r of ['pr_sync', 'pr_diff']) assert.equal(t.riskyWhen({ op: r }), false, `${r} is a read`);
    for (const w of ['pr_create', 'pr_comment', 'pr_review', 'pr_reply']) assert.equal(t.riskyWhen({ op: w }), true, `${w} must be gated`);
  });
  test('throwing getters on args → render/riskyWhen/run degrade, never throw', async () => {
    const hostile = { get op() { throw new Error('boom'); } };
    assert.equal(t.render(hostile), 'gh ?');
    assert.equal(t.riskyWhen(hostile), false);
    const out = await t.run(hostile);
    assert.match(out, /ERROR: the gh args are hostile/);
  });
  test('junk args objects → honest render + non-risky + teaching run', async () => {
    assert.equal(t.render(null), 'gh ?');
    assert.equal(t.render('x'), 'gh ?');
    assert.equal(t.riskyWhen(null), false);
    assert.equal(t.riskyWhen(42), false);
    const out = await t.run(null);
    assert.match(out, /unknown gh op/);
  });
  test('__proto__ in args stays DATA (no prototype pollution via the run path)', async () => {
    const args = JSON.parse('{"__proto__":{"polluted":1},"op":"nope"}');
    const out = await t.run(args);
    assert.match(out, /unknown gh op/);
    assert.equal({}.polluted, undefined);
  });
});
