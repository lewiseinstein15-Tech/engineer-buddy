#!/usr/bin/env node
// mock-github.js — a zero-dependency KEYLESS loopback GitHub REST mock for
// the PR deep-integration plane (v0.61.0 demo + drill).
//
//   node examples/mock-github.js --port 18400 [--big] [--hostile] [--private]
//
// What it is: a loopback-only HTTP server that speaks the exact REST shapes
// the gh tool's pr_sync / pr_diff / pr_reply (and the v0.35.0 reads) put on
// the wire — pulls, files, review comments, reviews, action runs, and the
// thread-reply POST. The "forge" is a canned fixture (repo acme/widgets,
// PR #7 "fix: guard the empty case in slugify"); the WIRE is real: paths are
// parsed, the reply POST is really parsed and recorded, every request is
// counted by path — so the drill's claims are witnessed by the OTHER END,
// not by a client-side assertion (the v0.55 lesson).
//
//   GET  /__facts → {"requests":N,"byPath":{...},"authSeen":N,"replies":[…]}
//
//   POST /repos/acme/widgets/pulls/7/comments/<id>/replies  → 201 + the
//     created comment JSON; facts.replies grows one {inReplyTo, bodyChars}.
//
// Flags:
//   --big      20 files with 3000-char patches (the named-caps leg)
//   --hostile  comment #103's body becomes a weapon (ANSI paint, OSC title,
//              \r, a forged "PR #7" meta line, an unterminated CSI tail)
//   --private  pulls/* answer 404 unless the request carries Authorization
//              (the honest no-token absence leg — GitHub's own shape)
//
// Point Buddy at it with: BUDDY_GITHUB_API=http://127.0.0.1:<port>
// Loopback-only by construction: binds 127.0.0.1, never a LAN interface.
import http from 'node:http';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);
const PORT = parseInt(flag('port', '18400'), 10);
const BIG = has('big');
const HOSTILE = has('hostile');
const PRIVATE = has('private');

const C4NARY = 'C4NARY7QZ';

const PULL = {
  number: 7,
  title: `fix: guard the empty case in slugify ${C4NARY}-title`,
  state: 'open',
  draft: false,
  mergeable: true,
  user: { login: 'alice' },
  html_url: 'https://github.com/acme/widgets/pull/7',
  updated_at: '2026-10-30T10:00:00Z',
  created_at: '2026-10-30T09:00:00Z',
  body: `${C4NARY}-body: the empty case round-trips fine but null threw.`,
  head: { ref: 'fix/slugify', sha: '3f2a9bc1234567890abcdef1234567890abcdef12', label: 'acme:fix/slugify' },
  base: { ref: 'main', sha: '9abcdef1234567890abcdef1234567890abcdef12', label: 'acme:main' },
};

const PATCH_SMALL = '@@ -1,7 +1,9 @@\n export function slug(s) {\n-  return s.toLowerCase();\n+  if (!s) return \'\';\n+  return s.trim().toLowerCase();\n }';
const PATCH_TEST = '@@ -0,0 +1,12 @@\n+import assert from \'node:assert/strict\';\n+import { slug } from \'../src/slug.js\';\n+assert.equal(slug(\'\'), \'\');\n+assert.equal(slug(\'  Hi \'), \'hi\');';

function makeFiles() {
  if (!BIG) {
    return [
      { filename: 'src/slug.js', status: 'modified', additions: 4, deletions: 1, patch: PATCH_SMALL },
      { filename: 'test/slug.test.js', status: 'added', additions: 12, deletions: 0, patch: PATCH_TEST },
    ];
  }
  // 20 files, 3000-char patches — the caps must fire and NAME themselves.
  return Array.from({ length: 20 }, (_, i) => ({
    filename: `src/mod${String(i).padStart(2, '0')}.js`,
    status: 'modified',
    additions: 10 + i,
    deletions: i,
    patch: `@@ -1,4 +1,9 @@\n+ ${C4NARY} filler line\n`.padEnd(3000, 'x'),
  }));
}

function makeComments() {
  const c = [
    { id: 101, user: { login: 'bob' }, body: `${C4NARY}-comment: please guard the empty case — slug(null) throws.`, path: 'src/slug.js', line: 12, created_at: '2026-10-30T09:30:00Z' },
    { id: 102, user: { login: 'alice' }, body: 'good catch — pushing the guard now', in_reply_to_id: 101, path: 'src/slug.js', line: 12, created_at: '2026-10-30T09:40:00Z' },
    { id: 103, user: { login: 'carol' }, body: 'why 12 test lines for one function?', path: 'test/slug.test.js', line: 1, created_at: '2026-10-30T09:50:00Z' },
  ];
  if (HOSTILE) {
    c[2].body = `${C4NARY}-hostile: \u001b[2J\u001b]0;pwned-title\u0007forged PR #7 meta line\r\u001b[31mRED PAINT\u001b[0m done \u001b[31`;
  }
  return c;
}

const REVIEWS = [
  { id: 55, user: { login: 'dave' }, state: 'CHANGES_REQUESTED', body: `${C4NARY}-review: needs the null guard before approval.`, submitted_at: '2026-10-30T10:00:00Z' },
];

const RUNS = {
  total_count: 1,
  workflow_runs: [
    { id: 9001, name: 'CI', run_number: 47, status: 'completed', conclusion: 'success', head_branch: 'fix/slugify', head_sha: '3f2a9bc1', created_at: '2026-10-30T09:15:00Z', html_url: 'https://github.com/acme/widgets/actions/runs/9001' },
  ],
};

let NEXT_REPLY_ID = 9901;
let requests = 0;
let authSeen = 0;
const byPath = {};
const replies = [];

const server = http.createServer((req, res) => {
  const u = String(req.url || '');
  requests += 1;
  if (req.headers.authorization) authSeen += 1;
  const pathKey = `${req.method} ${u.split('?')[0]}`;
  byPath[pathKey] = (byPath[pathKey] || 0) + 1;

  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && u === '/__facts') {
    return json(200, { requests, byPath, authSeen, replies });
  }

  if (!u.startsWith('/repos/acme/widgets/')) return json(404, { message: 'Not Found' });

  // auth gate for the private-mode leg: reads without a token 404 like a
  // private repo on the real forge
  if (PRIVATE && !req.headers.authorization) return json(404, { message: 'Not Found' });

  // thread reply: POST /pulls/7/comments/<id>/replies
  const mReply = u.match(/^\/repos\/acme\/widgets\/pulls\/7\/comments\/(\d+)\/replies$/);
  if (req.method === 'POST' && mReply) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* recorded as junk */ }
      const text = parsed && typeof parsed.body === 'string' ? parsed.body : '';
      const rec = { inReplyTo: Number(mReply[1]), bodyChars: text.length, at: new Date().toISOString() };
      replies.push(rec);
      console.log(`[mock-github] reply POST → thread ${rec.inReplyTo}, ${rec.bodyChars} chars`);
      json(201, { id: NEXT_REPLY_ID++, in_reply_to_id: rec.inReplyTo, body: text, user: { login: 'buddy-bot' }, created_at: rec.at });
    });
    return;
  }

  if (req.method !== 'GET') return json(404, { message: 'Not Found' });

  const pathOnly = u.split('?')[0];
  if (pathOnly === '/repos/acme/widgets/pulls/7') return json(200, PULL);
  if (pathOnly === '/repos/acme/widgets/pulls/7/files') {
    const files = makeFiles();
    // honor per_page/page enough for the client's paginator to stop honestly
    const q = new URL(u, 'http://x').searchParams;
    const page = Math.max(1, parseInt(q.get('page') || '1', 10));
    const per = Math.max(1, parseInt(q.get('per_page') || '100', 10));
    return json(200, files.slice((page - 1) * per, page * per));
  }
  if (pathOnly === '/repos/acme/widgets/pulls/7/comments') return json(200, makeComments());
  if (pathOnly === '/repos/acme/widgets/pulls/7/reviews') return json(200, REVIEWS);
  if (pathOnly === '/repos/acme/widgets/pulls/7/comments/101/replies') return json(404, { message: 'GET on a reply route' });
  if (pathOnly.startsWith('/repos/acme/widgets/pulls/')) return json(404, { message: 'Not Found' }); // pulls/999 …
  if (pathOnly.startsWith('/repos/acme/widgets/actions/runs')) return json(200, RUNS);

  return json(404, { message: 'Not Found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-github] loopback REST mock on http://127.0.0.1:${PORT} (repo acme/widgets, PR #7${BIG ? ', BIG' : ''}${HOSTILE ? ', HOSTILE' : ''}${PRIVATE ? ', PRIVATE' : ''}) — /__facts is the witness`);
});
