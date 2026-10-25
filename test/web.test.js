import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWebTools, htmlToText, decodeEntities, parseDdgResults, blockedHost } from '../src/tools/web.js';

// ── Fixtures (offline — no real network calls in tests) ─────────────────────

const DDG_HTML = `
<html><body>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&amp;rut=abc">Node.js <b>fs</b> API docs</a>
  <a class="result__snippet" href="#">File system documentation for the Node.js API.</a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="https://example.com/direct">Direct link result</a>
  <a class="result__snippet" href="#">A second result with <b>bold</b> text.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&amp;rut=xyz">Duplicate</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2Flocalhost%2Fsecret">Local result</a>
</div>
</body></html>`;

const DDG_LITE = `
<html><body><table>
<tr><td><a rel="nofollow" href="https://developer.mozilla.org/en-US/docs/Web/JavaScript" class='result-link'>MDN JavaScript guide</a></td></tr>
<tr><td class='result-snippet'>The JavaScript reference on MDN.</td></tr>
</table></body></html>`;

function fakeFetch(pages) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push(url);
    for (const [match, page] of pages) {
      if (typeof match === 'string' ? url.includes(match) : match.test(url)) {
        if (page instanceof Error) throw page;
        if (typeof page === 'number') return { ok: page < 400, status: page, headers: { get: () => 'text/html' }, text: async () => 'error page' };
        return { ok: true, status: 200, headers: { get: () => page.type || 'text/html' }, text: async () => page.body };
      }
    }
    return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
  };
  fn.calls = calls;
  return fn;
}

// ── htmlToText / entities ────────────────────────────────────────────────────

test('decodeEntities: named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;&#x27; &nbsp;&mdash;'), `a & b <c> '' \u00a0—`);
});

test('htmlToText: strips scripts, styles, comments, tags; keeps text with newlines', () => {
  const html = `<html><head><style>.x{color:red}</style><script>evil()</script></head>
    <!-- hidden comment -->
    <body><h1>Title</h1><p>First &amp; second</p><ul><li>one</li><li>two</li></ul>
    <div>line<br>break</div></body></html>`;
  const text = htmlToText(html);
  assert.ok(!text.includes('evil()'));
  assert.ok(!text.includes('color:red'));
  assert.ok(!text.includes('hidden comment'));
  assert.ok(text.includes('Title'));
  assert.ok(text.includes('First & second'));
  assert.ok(text.includes('one'));
  assert.ok(text.includes('line\nbreak'));
});

test('htmlToText: collapses excessive blank lines and trims', () => {
  const text = htmlToText('<div>a</div><div></div><div></div><div></div><div>b</div>');
  assert.equal(text, 'a\n\nb');
});

// ── SSRF guard ───────────────────────────────────────────────────────────────

test('blockedHost: local, private and metadata targets blocked; public allowed', () => {
  for (const host of ['localhost', 'sub.localhost', 'box.local', 'host.internal', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.1.1', '172.31.255.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(blockedHost(host), true, host);
  }
  for (const host of ['example.com', 'nodejs.org', '8.8.8.8', '172.32.0.1']) {
    assert.equal(blockedHost(host), false, host);
  }
});

// ── DuckDuckGo parsing ───────────────────────────────────────────────────────

test('parseDdgResults: unwraps uddg links, pairs snippets, dedupes, drops unsafe URLs', () => {
  const results = parseDdgResults(DDG_HTML, { limit: 10 });
  assert.equal(results.length, 2); // duplicate URL deduped, localhost dropped
  assert.equal(results[0].url, 'https://nodejs.org/api/fs.html');
  assert.equal(results[0].title, 'Node.js fs API docs');
  assert.equal(results[0].snippet, 'File system documentation for the Node.js API.');
  assert.equal(results[1].url, 'https://example.com/direct');
  assert.equal(results[1].snippet, 'A second result with bold text.');
});

test('parseDdgResults: respects limit', () => {
  const results = parseDdgResults(DDG_HTML, { limit: 1 });
  assert.equal(results.length, 1);
});

test('parseDdgResults: parses the lite endpoint shape', () => {
  const results = parseDdgResults(DDG_LITE, { limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://developer.mozilla.org/en-US/docs/Web/JavaScript');
  assert.equal(results[0].title, 'MDN JavaScript guide');
  assert.equal(results[0].snippet, 'The JavaScript reference on MDN.');
});

// ── web_fetch ────────────────────────────────────────────────────────────────

test('web_fetch: converts HTML to text, caps content', async () => {
  const fetchImpl = fakeFetch([[/example\.com/, { body: '<html><body><p>' + 'word '.repeat(5000) + '</p></body></html>' }]]);
  const [, webFetch] = buildWebTools({ fetchImpl });
  const out = await webFetch.run({ url: 'https://example.com/page', max_chars: 200 });
  assert.ok(out.startsWith('FETCHED https://example.com/page'));
  assert.ok(out.includes('truncated'));
  assert.ok(!out.includes('<p>'));
});

test('web_fetch: JSON content passes through unconverted', async () => {
  const fetchImpl = fakeFetch([[/api\.example\.com/, { type: 'application/json', body: '{"ok":true}' }]]);
  const [, webFetch] = buildWebTools({ fetchImpl });
  const out = await webFetch.run({ url: 'https://api.example.com/v1' });
  assert.ok(out.includes('"ok":true'));
});

test('web_fetch: rejects non-http schemes and internal hosts without calling fetch', async () => {
  const fetchImpl = fakeFetch([]);
  const [ws, webFetch] = buildWebTools({ fetchImpl });
  assert.match(await webFetch.run({ url: 'file:///etc/passwd' }), /ERROR.*http\(s\)/);
  assert.match(await webFetch.run({ url: 'ftp://example.com' }), /ERROR.*http\(s\)/);
  assert.match(await webFetch.run({ url: 'http://localhost/secret' }), /ERROR.*local/);
  assert.match(await webFetch.run({ url: 'http://169.254.169.254/latest/meta-data' }), /ERROR.*local/);
  assert.match(await webFetch.run({ url: 'not a url' }), /ERROR.*valid/);
  assert.equal(fetchImpl.calls.length, 0);
  assert.ok(ws && webFetch); // both tools built
});

test('web_fetch: HTTP errors and network failures return friendly ERROR lines', async () => {
  const fetch404 = fakeFetch([[/x\.com/, 404]]);
  const [, c] = buildWebTools({ fetchImpl: fetch404 });
  assert.match(await c.run({ url: 'https://x.com/missing' }), /ERROR: HTTP 404/);

  const fetchBoom = fakeFetch([[/y\.com/, new Error('ECONNREFUSED')]]);
  const [, d] = buildWebTools({ fetchImpl: fetchBoom });
  assert.match(await d.run({ url: 'https://y.com/' }), /ERROR: fetch failed/);
});

// ── web_search ───────────────────────────────────────────────────────────────

test('web_search: formats results from the html endpoint', async () => {
  const fetchImpl = fakeFetch([['duckduckgo.com/html', { body: DDG_HTML }]]);
  const [webSearch] = buildWebTools({ fetchImpl });
  const out = await webSearch.run({ query: 'node fs api' });
  assert.ok(out.startsWith('SEARCH "node fs api"'));
  assert.ok(out.includes('https://nodejs.org/api/fs.html'));
  assert.ok(out.includes('Node.js fs API docs'));
  assert.equal(fetchImpl.calls.length, 1);
});

test('web_search: falls back to the lite endpoint when html endpoint is empty', async () => {
  const fetchImpl = fakeFetch([
    ['duckduckgo.com/html', { body: '<html><body>no results here</body></html>' }],
    ['duckduckgo.com/lite', { body: DDG_LITE }],
  ]);
  const [webSearch] = buildWebTools({ fetchImpl });
  const out = await webSearch.run({ query: 'mdn js', n: 3 });
  assert.ok(out.includes('https://developer.mozilla.org/en-US/docs/Web/JavaScript'));
  assert.equal(fetchImpl.calls.length, 2);
});

test('web_search: graceful error when every endpoint fails or is empty', async () => {
  const fetchImpl = fakeFetch([]);
  const [webSearch] = buildWebTools({ fetchImpl });
  const out = await webSearch.run({ query: 'anything' });
  assert.match(out, /ERROR: no results/);
  assert.match(out, /web_fetch/); // nudges the model to the fallback tool
});

test('web_search: validates input', async () => {
  const [webSearch] = buildWebTools({ fetchImpl: fakeFetch([]) });
  assert.match(await webSearch.run({}), /ERROR: query required/);
  assert.match(await webSearch.run({ query: '' }), /ERROR: query required/);
});

// ── Tool surface (registry shape) ────────────────────────────────────────────

test('web tools expose the registry contract: name/description/args/render, not risky', () => {
  const tools = buildWebTools({ fetchImpl: fakeFetch([]) });
  assert.deepEqual(tools.map((t) => t.name), ['web_search', 'web_fetch']);
  for (const t of tools) {
    assert.ok(t.description.length > 30, t.name);
    assert.ok(typeof t.args === 'string' && t.args.startsWith('{'), t.name);
    assert.equal(typeof t.render({ url: 'https://x.com', query: 'q' }), 'string');
    assert.notEqual(t.risky, true); // read-only — no approval gate
  }
});
