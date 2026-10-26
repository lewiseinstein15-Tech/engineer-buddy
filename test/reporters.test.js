// Reporters (v0.26.0): named API request presets in .buddy/reporters/*.json —
// validation, loading with junk tolerance, and running through the http engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateReporter, loadReporters, findReporter, runReporter } from '../src/tools/reporters.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-reporters-'));
}

const GOOD = {
  description: 'Latest CI runs',
  request: {
    method: 'GET',
    url: 'https://api.github.com/repos/o/r/actions/runs?per_page=5',
    headers: { Accept: 'application/vnd.github+json' },
    auth: { type: 'bearer', env: 'GITHUB_TOKEN' },
  },
};

test('validateReporter: accepts good presets; refuses junk with precise errors', () => {
  const v = validateReporter(GOOD, 'ci');
  assert.equal(v.ok, true);
  assert.equal(v.reporter.name, 'ci');
  assert.equal(v.reporter.request.method, 'GET');
  // name defaults to the file stem and gets sanitized
  assert.equal(validateReporter({ request: { url: 'https://x.dev/' } }, 'My Reporter!').reporter.name, 'my-reporter');
  assert.equal(validateReporter(null, 'x').ok, false);
  assert.match(validateReporter({}, 'x').error, /missing "request"/);
  assert.match(validateReporter({ request: { url: 'not a url' } }, 'x').error, /not a valid absolute URL/);
  assert.match(validateReporter({ request: { url: 'ftp://x/' } }, 'x').error, /http\(s\)/);
  assert.match(validateReporter({ request: { url: 'https://x/', method: 'BREW' } }, 'x').error, /not allowed/);
  assert.match(validateReporter({ request: { url: 'https://x/', auth: { type: 'bearer', token: 'ghp_x' } } }, 'x').error, /secrets never live in reporter files/);
  assert.match(validateReporter({ request: { url: 'https://x/', auth: { type: 'magic' } } }, 'x').error, /bearer \| basic \| header/);
});

test('loadReporters: loads valid files, tolerates junk, dedupes names, honest warnings', () => {
  const root = tmp();
  const dir = path.join(root, '.buddy', 'reporters');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ci.json'), JSON.stringify(GOOD));
  fs.writeFileSync(path.join(dir, 'prices.json'), JSON.stringify({ request: { url: 'https://prices.example.com/api', method: 'GET' } }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'nosecret.json'), JSON.stringify({ request: { url: 'https://x.dev/', auth: { token: 'oops' } } }));
  fs.writeFileSync(path.join(dir, 'dup.json'), JSON.stringify({ name: 'ci', request: { url: 'https://x.dev/' } }));
  fs.writeFileSync(path.join(dir, 'ignoreme.txt'), 'not json at all');
  const { reporters, warnings } = loadReporters(root);
  assert.deepEqual(reporters.map((r) => r.name), ['ci', 'prices'], 'valid ones load in name order; duplicate name ignored');
  assert.equal(warnings.length, 3, 'broken + literal-secret + duplicate-name each warn');
  assert.ok(warnings.some((w) => w.includes('broken.json')));
  assert.ok(warnings.some((w) => w.includes('nosecret.json')));
  assert.ok(warnings.some((w) => w.includes('dup.json')));
  // missing dir is the normal case
  const empty = loadReporters(tmp());
  assert.deepEqual(empty.reporters, []);
  assert.deepEqual(empty.warnings, []);
});

test('findReporter: exact, then prefix; runReporter sends the preset through http', async () => {
  const { reporters } = loadReporters((() => {
    const root = tmp();
    const dir = path.join(root, '.buddy', 'reporters');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ci.json'), JSON.stringify(GOOD));
    fs.writeFileSync(path.join(dir, 'ci-daily.json'), JSON.stringify({ request: { url: 'https://ci.example.com/daily' } }));
    return root;
  })());
  assert.equal(findReporter(reporters, 'ci').name, 'ci');
  assert.equal(findReporter(reporters, 'ci-').name, 'ci-daily');
  assert.equal(findReporter(reporters, 'zzz'), null);
  assert.equal(findReporter(reporters, ''), null);

  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"workflow_runs":[]}' };
  };
  const out = await runReporter(findReporter(reporters, 'ci'), { fetchImpl, env: { GITHUB_TOKEN: 'tok_abc' } });
  assert.match(out, /HTTP 200 GET https:\/\/api\.github\.com\/repos\/o\/r\/actions\/runs/);
  assert.equal(calls[0].opts.headers.authorization, 'Bearer tok_abc', 'env-ref auth resolves at run time');
  assert.equal(calls[0].opts.headers.accept, 'application/vnd.github+json');
  assert.match(out, /workflow_runs/, 'body in the observation');
});
