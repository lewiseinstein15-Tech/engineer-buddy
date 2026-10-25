import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, mdTitle } from '../src/terminal/markdown.js';

test('markdown: headings render as text (identity palette by default)', () => {
  const out = renderMarkdown('## A Heading\n\nbody text');
  assert.match(out, /A Heading/);
  assert.match(out, /body text/);
});

test('markdown: inline code is preserved', () => {
  const out = renderMarkdown('run `npm test` now');
  assert.match(out, /npm test/);
  assert.match(out, /run .* now/);
});

test('markdown: bold markers are stripped in plain mode', () => {
  const out = renderMarkdown('this is **important** stuff');
  assert.ok(!out.includes('**'));
  assert.match(out, /important/);
});

test('markdown: bullets become • items', () => {
  const out = renderMarkdown('- first\n- second\n* third');
  assert.match(out, /• first/);
  assert.match(out, /• second/);
  assert.match(out, /• third/);
});

test('markdown: fenced code blocks are framed and kept verbatim', () => {
  const out = renderMarkdown('```js\nconst x = 1;\n```');
  assert.match(out, /const x = 1;/);
  assert.match(out, /┌/);
  assert.match(out, /└/);
});

test('markdown: unclosed fence does not lose content', () => {
  const out = renderMarkdown('```\nconst y = 2;');
  assert.match(out, /const y = 2;/);
  assert.match(out, /└/);
});

test('markdown: links become text + url', () => {
  const out = renderMarkdown('see [docs](https://example.com/x) here');
  assert.match(out, /docs/);
  assert.match(out, /https:\/\/example.com\/x/);
});

test('markdown: numbered lists keep their numbers', () => {
  const out = renderMarkdown('1. one\n2) two');
  assert.match(out, /1\. one/);
  assert.match(out, /2\. two/);
});

test('markdown: quotes are piped', () => {
  const out = renderMarkdown('> quoted wisdom');
  assert.match(out, /quoted wisdom/);
});

test('mdTitle: picks the heading, strips markers, caps length', () => {
  assert.equal(mdTitle('## Fix the login bug\n\nbody'), 'Fix the login bug');
  assert.equal(mdTitle('plain **first** line'), 'plain first line');
  const long = mdTitle('x'.repeat(200));
  assert.ok(long.length <= 80 && long.endsWith('…'));
});
