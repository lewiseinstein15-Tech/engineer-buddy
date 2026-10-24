import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, globMatches, maskSecret, truncate, toInt } from '../src/util.js';

test('extractJson: direct JSON object', () => {
  const r = extractJson('{"a":1}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { a: 1 });
});

test('extractJson: markdown-fenced JSON', () => {
  const r = extractJson('Here you go:\n```json\n{"verdict":"approve","findings":[]}\n```\nDone!');
  assert.equal(r.ok, true);
  assert.equal(r.value.verdict, 'approve');
});

test('extractJson: JSON with prose before and after', () => {
  const r = extractJson('Sure! {"tool":"read_file","args":{"path":"src/x.js"}} hope that helps');
  assert.equal(r.ok, true);
  assert.equal(r.value.tool, 'read_file');
});

test('extractJson: braces inside strings do not break the scanner', () => {
  const r = extractJson('{"code":"function f(){ return {x:1}; }","line":3}');
  assert.equal(r.ok, true);
  assert.equal(r.value.line, 3);
});

test('extractJson: trailing comma repair', () => {
  const r = extractJson('{"verdict":"comment","findings":[],}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.findings, []);
});

test('extractJson: garbage returns ok:false, never throws', () => {
  const r = extractJson('this is just words, no json at all');
  assert.equal(r.ok, false);
  assert.equal(r.value, null);
});

test('extractJson: empty input', () => {
  assert.equal(extractJson('').ok, false);
  assert.equal(extractJson(null).ok, false);
});

test('globMatches: patterns', () => {
  assert.equal(globMatches('**/.env*', '.env.local'), true);
  assert.equal(globMatches('**/.env*', 'src/.env'), true);
  assert.equal(globMatches('**/*.pem', 'certs/server.pem'), true);
  assert.equal(globMatches('**/*.key', 'src/app.js'), false);
  assert.equal(globMatches('secrets.*', 'secrets.json'), true);
});

test('maskSecret keeps ends only', () => {
  const m = maskSecret('AKIAIOSFODNN7EXAMPLE');
  assert.ok(m.startsWith('AKI'));
  assert.ok(m.endsWith('PLE'));
  assert.ok(m.includes('*'));
});

test('truncate + toInt', () => {
  assert.equal(truncate('abcdef', 4), 'abcd…[+2 chars]');
  assert.equal(toInt('42', 0), 42);
  assert.equal(toInt('nope', 7), 7);
});
