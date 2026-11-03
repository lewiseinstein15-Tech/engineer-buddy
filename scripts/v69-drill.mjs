// V69 DRILL — Wave 5, session search (the plan calls it t9), end to end:
//   - .buddy/index/sessions.idx builds incrementally (the cursor is the
//     per-file byte offset; a pass reads only what was appended),
//   - a torn tail line is never indexed and the index keeps working,
//   - a 10k-line transcript answers a query in < 50 ms — no LLM in the loop,
//   - rebuild from zero reproduces the same answers,
//   - the index write is atomic (tmp + rename), no litter.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.dirname(new URL(import.meta.url).pathname).replace(/\/scripts$/, '');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v69-'));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`[verify] ${name}:`, ok ? 'PASS' : 'FAIL', detail);
  if (!ok) failures += 1;
};

const { SessionRecorder } = await import(`${REPO}/src/session.js`);
const { buildIndex, searchIndex, rebuildIndex, indexPath } = await import(`${REPO}/src/sessionsidx.js`);

console.log(`workspace: ${root}\n`);

// 1 — three realistic sessions with distinct vocabularies
const s1 = new SessionRecorder(root, 'fix the zebra migration in the stable crate');
s1.append({ type: 'user', text: 'fix the zebra migration in the stable crate' });
s1.append({ type: 'say', text: 'migration reordered, tests green' });
const s2 = new SessionRecorder(root, 'write the delivery ledger for serve wave 2');
s2.append({ type: 'user', text: 'write the delivery ledger for serve wave 2' });
s2.append({ type: 'say', text: 'the zebra crate ships tomorrow alongside the ledger' });
const s3 = new SessionRecorder(root, 'harbor dredging permit follow-up');
s3.append({ type: 'user', text: 'harbor dredging permit follow-up' });
s3.append({ type: 'say', text: 'permit granted, dredging starts monday' });

const built = buildIndex(root);
check('first pass indexes every transcript (fresh)', built.fresh === 3 && built.files === 3, `fresh=${built.fresh}`);

const res = searchIndex(root, 'zebra');
check('search finds both zebra sessions', res.hits.length === 2);
check(
  'first-task hit outranks body hit',
  res.hits[0].name === path.basename(s1.path) && res.hits[0].score > res.hits[1].score,
  `top=${res.hits[0].name} score ${res.hits[0].score} > ${res.hits[1].score}`
);
check('unmatched terms return nothing', searchIndex(root, 'unicorn').hits.length === 0);

// 2 — the cursor: only appended bytes are read on the second pass
s2.append({ type: 'say', text: 'the PONTAL convention lands in phase two' });
const second = buildIndex(root);
check('incremental pass reads only the appended bytes', second.changed === 1 && second.bytes > 0 && second.bytes < 400, `bytes=${second.bytes}`);
check('appended line is searchable', searchIndex(root, 'pontal').hits.length === 1);

// 3 — a torn tail line is never indexed; the index keeps working
fs.appendFileSync(s1.path, '{"type":"say","text":"the QUORUM rule is', 'utf8');
check('torn tail is not indexed', searchIndex(root, 'quorum').hits.length === 0);
s1.append({ type: 'say', text: 'the docket was sealed' });
buildIndex(root);
check('glued corrupt line still not indexed (loadSession rule)', searchIndex(root, 'quorum').hits.length === 0);
check('the session still searches after the torn tail', searchIndex(root, 'zebra migration').hits.length >= 1);

// 4 — the t9 bar: 10k-line transcript, query < 50 ms
const burn = new SessionRecorder(root, 'transcript burn-in for t9');
burn.append({ type: 'user', text: 'transcript burn-in for t9' });
burn.append({ type: 'say', text: 'the CANTILEVER verdict is buried somewhere in here' });
for (let i = 0; i < 10_000; i += 1) {
  burn.append({ type: 'tool', tool: 'fs_read', args: { _preview: `src/f${i % 97}.js` }, observation: `filler ${i}` });
}
burn.append({ type: 'say', text: 'closing note' });
const big = buildIndex(root);
check('10k-line transcript indexed', big.fresh === 1, `took ${big.tookMs}ms`);
let worst = 0;
for (const q of ['cantilever', 'zebra', 'pontal', 'harbor dredging', 'cantilever verdict']) {
  const r = searchIndex(root, q);
  worst = Math.max(worst, r.tookMs);
}
check('worst query < 50 ms (the plan bar)', worst < 50, `worst=${worst}ms`);

// 5 — rebuild from zero reproduces the same answers
const before = searchIndex(root, 'zebra pontal cantilever').hits.map((h) => h.name);
fs.rmSync(path.dirname(indexPath(root)), { recursive: true, force: true });
const again = rebuildIndex(root);
const after = searchIndex(root, 'zebra pontal cantilever').hits.map((h) => h.name);
check('rebuild from zero works', again.fresh === 4 && JSON.stringify(after) === JSON.stringify(before));

// 6 — the index write is atomic
check('no .tmp litter, trailing newline marks an intact index', !fs.existsSync(`${indexPath(root)}.tmp`) && fs.readFileSync(indexPath(root), 'utf8').endsWith('\n'));

console.log(`\nfailures: ${failures}`);
process.exit(failures ? 1 : 0);
