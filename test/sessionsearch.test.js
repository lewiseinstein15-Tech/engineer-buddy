// Wave 5 session search (v0.69.0) — cursor-built .buddy/index/sessions.idx,
// /sessions --search. The plan's t9 bar: incremental, crash-safe (a torn tail
// line is never indexed), rebuild from zero works, query < 50 ms on a
// 10k-line transcript, no LLM in the loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRecorder } from '../src/session.js';
import { buildIndex, rebuildIndex, searchIndex, readIndex, indexPath, tokenize } from '../src/sessionsidx.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-idx-'));
}

function makeSession(root, firstText, texts) {
  const rec = new SessionRecorder(root, firstText);
  rec.append({ type: 'user', text: firstText });
  for (const t of texts) rec.append({ type: 'say', text: t });
  return rec;
}

test('tokenize: lowercases, drops stopwords and short words', () => {
  assert.deepEqual(tokenize('The Quick brown-fox and it IS zebra9'), ['quick', 'brown', 'fox', 'zebra9']);
});

test('build indexes transcripts; search ranks first-task hits above body hits', () => {
  const root = tmpRoot();
  makeSession(root, 'fix the zebra migration', ['it lives in the stable', 'done, tests green']);
  makeSession(root, 'write the delivery ledger', ['the zebra crate ships tomorrow', 'committed']);

  const built = buildIndex(root);
  assert.equal(built.files, 2);
  assert.equal(built.fresh, 2);

  const res = searchIndex(root, 'zebra');
  assert.equal(res.hits.length, 2);
  assert.match(res.hits[0].name, /zebra-migration/); // first-task hit outranks body hit
  assert.ok(res.hits[0].score > res.hits[1].score);
  assert.deepEqual(res.hits[0].matched, ['zebra']);

  const none = searchIndex(root, 'unicorn');
  assert.equal(none.hits.length, 0);
});

test('incremental: a second pass reads only the appended bytes (the cursor)', () => {
  const root = tmpRoot();
  const rec = makeSession(root, 'kayak logistics plan', ['phase one complete']);
  buildIndex(root);

  rec.append({ type: 'say', text: 'the PONTAL convention lands in phase two' });
  const second = buildIndex(root);

  assert.equal(second.changed, 1); // exactly one file moved
  assert.equal(second.fresh, 0);
  assert.ok(second.bytes > 0 && second.bytes < 400, `delta bytes small, got ${second.bytes}`);
  const found = searchIndex(root, 'pontal');
  assert.equal(found.hits.length, 1); // the appended line is searchable
  const still = searchIndex(root, 'kayak');
  assert.equal(still.hits.length, 1); // the old terms survive
});

test('a torn tail line is never indexed, and the index keeps working after it', () => {
  const root = tmpRoot();
  const rec = makeSession(root, 'teapot telemetry', ['all clear']);
  buildIndex(root);

  fs.appendFileSync(rec.path, '{"type":"say","text":"the QUORUM rule is', 'utf8'); // crash mid-append: no \n, no closing brace
  assert.equal(searchIndex(root, 'quorum').hits.length, 0, 'torn tail must not be indexed');

  // the next real append glues onto the torn fragment — one corrupt physical
  // line, skipped forever (same rule as loadSession), but later lines index
  rec.append({ type: 'say', text: 'the docket was sealed' });
  const built = buildIndex(root);
  assert.equal(built.fresh + built.changed, 1);
  assert.equal(searchIndex(root, 'quorum').hits.length, 0, 'the glued corrupt line is still not indexed');
  assert.equal(searchIndex(root, 'docket').hits.length, 0, 'the glued corrupt line took its event down with it');
  assert.equal(searchIndex(root, 'teapot').hits.length, 1, 'everything before the torn tail still searches');
});

test('a shrunken transcript is reindexed from zero (no stale terms)', () => {
  const root = tmpRoot();
  const rec = makeSession(root, 'orchard inventory', ['apples and pears']);
  buildIndex(root);

  // same-size-ish rewrite with different words: the head hash, not the size, must catch it
  fs.writeFileSync(rec.path, '', 'utf8');
  fs.appendFileSync(rec.path, JSON.stringify({ at: new Date().toISOString(), type: 'user', text: 'orchard inventory' }) + '\n');
  fs.appendFileSync(rec.path, JSON.stringify({ at: new Date().toISOString(), type: 'say', text: 'only quinces remain now' }) + '\n');

  const built = buildIndex(root);
  assert.equal(built.fresh, 1);
  assert.equal(searchIndex(root, 'pears').hits.length, 0, 'old body term is gone');
  assert.equal(searchIndex(root, 'quinces').hits.length, 1);
});

test('rebuild from zero reproduces the same answers', () => {
  const root = tmpRoot();
  makeSession(root, 'granite counter tops', ['slab arrived cracked']);
  makeSession(root, 'giraffe enclosure', ['tall fence ordered']);
  buildIndex(root);
  const before = searchIndex(root, 'granite giraffe');

  fs.rmSync(path.dirname(indexPath(root)), { recursive: true, force: true });
  const again = rebuildIndex(root);
  assert.equal(again.fresh, 2);
  const after = searchIndex(root, 'granite giraffe');
  assert.deepEqual(after.hits.map((h) => h.name), before.hits.map((h) => h.name));
});

test('a torn index tail is dropped on read; valid entries survive untouched', () => {
  const root = tmpRoot();
  makeSession(root, 'cobalt pricing', ['locked']);
  buildIndex(root);
  fs.appendFileSync(indexPath(root), '{"v":1,"kind":"file","na', 'utf8'); // torn index line

  const read = readIndex(root);
  assert.equal(read.dropped, 0); // torn line never parsed as an entry
  assert.equal(read.entries.size, 1);

  const built = buildIndex(root);
  assert.equal(built.unchanged, 1); // the valid entry keeps its cursor — no rescan
  assert.equal(built.fresh, 0);
  assert.equal(searchIndex(root, 'cobalt').hits.length, 1);
});

test('the index write is atomic: no .tmp litter after a build', () => {
  const root = tmpRoot();
  makeSession(root, 'harbor dredging', ['permit granted']);
  buildIndex(root);
  assert.equal(fs.existsSync(`${indexPath(root)}.tmp`), false);
  assert.ok(fs.readFileSync(indexPath(root), 'utf8').endsWith('\n'));
});

test('empty query returns nothing; missing index is built on first search', () => {
  const root = tmpRoot();
  makeSession(root, 'lighthouse roster', ['keeper on duty']);
  const empty = searchIndex(root, '   ');
  assert.deepEqual(empty.hits, []);

  const res = searchIndex(root, 'lighthouse'); // no buildIndex call first
  assert.equal(res.hits.length, 1);
});

test('t9 bar: 10k-line transcript, query < 50 ms', () => {
  const root = tmpRoot();
  const rec = new SessionRecorder(root, 'transcript burn-in');
  rec.append({ type: 'user', text: 'transcript burn-in' });
  rec.append({ type: 'say', text: 'the CANTILEVER verdict is buried somewhere in here' });
  for (let i = 0; i < 10_000; i += 1) {
    rec.append({ type: 'tool', tool: 'fs_read', args: { _preview: `src/f${i % 97}.js` }, observation: `filler observation ${i} with ordinary words about buffers and queues` });
  }
  rec.append({ type: 'say', text: 'closing note' });

  const built = buildIndex(root);
  assert.ok(built.tookMs < 2_000, `10k-line build took ${built.tookMs}ms`);

  for (let i = 0; i < 3; i += 1) searchIndex(root, 'cantilever'); // warm
  const res = searchIndex(root, 'cantilever');
  assert.equal(res.hits.length, 1);
  assert.ok(res.tookMs < 50, `query took ${res.tookMs}ms, the plan demands < 50ms`);
});
