import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../src/diff.js';
import { scanSecrets, scanRisks } from '../src/tools/security.js';

const DIFF = `diff --git a/src/db.js b/src/db.js
--- a/src/db.js
+++ b/src/db.js
@@ -1,5 +1,9 @@
 const config = {};
+const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
+const GH = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
+const db = "postgres://admin:hunter2@db.internal:5432/prod";
+const fine = "the quick brown fox jumps over the lazy dog";
diff --git a/supabase/migrations/x.sql b/supabase/migrations/x.sql
--- a/supabase/migrations/x.sql
+++ b/supabase/migrations/x.sql
@@ -1,2 +1,4 @@
+CREATE TABLE wallets_payouts (id uuid);
+DROP TABLE audit_log;
`;

test('scanSecrets: finds AWS key, GitHub token, DB URI; ignores clean lines', () => {
  const parsed = parseUnifiedDiff(DIFF);
  const found = scanSecrets(parsed);
  const ids = found.map((f) => f.id);
  assert.ok(ids.includes('aws_access_key'));
  assert.ok(ids.includes('github_token'));
  assert.ok(ids.includes('db_uri'));
  assert.equal(found.filter((f) => f.label.includes('AWS')).length, 1);
  // snippet masked
  const aws = found.find((f) => f.id === 'aws_access_key');
  assert.ok(!aws.snippet.includes('IOSFODNN7EXAMPLE'));
});

test('scanRisks: flags SQL migration and money surface', () => {
  const parsed = parseUnifiedDiff(DIFF);
  const { risks, totalAdded } = scanRisks(parsed, { rawDiff: DIFF });
  assert.ok(totalAdded >= 6);
  const notes = risks.map((r) => r.note).join(' ');
  assert.ok(notes.includes('migration surface'));
  assert.ok(risks.some((r) => r.file === 'supabase/migrations/x.sql'));
});

test('scanRisks: flags dependency change in package.json', () => {
  const DIFF2 = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -5,3 +5,4 @@
   "dependencies": {
+    "left-pad": "^1.0.0",
     "react": "19.0.0"
   }`;
  const parsed = parseUnifiedDiff(DIFF2);
  const { risks } = scanRisks(parsed);
  assert.ok(risks.some((r) => r.note.startsWith('dependencies changed')));
});

test('scanRisks: flags eval / disabled TLS in raw diff', () => {
  const DIFF3 = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1,1 +1,2 @@
+httpsAgent: new https.Agent({ rejectUnauthorized: false })
`;
  const parsed = parseUnifiedDiff(DIFF3);
  const { risks } = scanRisks(parsed, { rawDiff: DIFF3 });
  assert.ok(risks.some((r) => r.note.includes('insecure pattern')));
});
