import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, renderDiffDigest } from '../src/diff.js';

const SAMPLE = `diff --git a/src/App.js b/src/App.js
index 111..222 100644
--- a/src/App.js
+++ b/src/App.js
@@ -10,7 +10,9 @@ function App() {
   const x = 1;
+  const y = 2;
   return (
     <div>
-      <Old />
+      <New />
+      <Another />
     </div>
   );
diff --git a/public/logo.png b/public/logo.png
index 333..444 100644
Binary files a/public/logo.png and b/public/logo.png differ
diff --git a/src/lib/util.js b/src/renamed-util.js
similarity index 90%
rename from src/lib/util.js
rename to src/renamed-util.js
--- a/src/lib/util.js
+++ b/src/renamed-util.js
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
`;

test('parseUnifiedDiff: file boundaries', () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.equal(files.length, 3);
  assert.equal(files[0].path, 'src/App.js');
  assert.equal(files[1].path, 'public/logo.png');
  assert.equal(files[2].path, 'src/renamed-util.js');
  assert.equal(files[2].oldPath, 'src/lib/util.js');
});

test('parseUnifiedDiff: added line numbers map to the NEW file', () => {
  const files = parseUnifiedDiff(SAMPLE);
  const app = files[0];
  assert.equal(app.additions, 3);
  assert.equal(app.deletions, 1);
  // hunk starts at new line 10; "+ const y = 2;" is line 11
  assert.equal(app.addedLines.get(11), '  const y = 2;');
  assert.equal(app.addedLines.get(14), '      <New />');
  assert.equal(app.addedLines.get(15), '      <Another />');
  assert.ok(!app.addedLines.has(12)); // context line
  assert.equal(app.removedLines[0], '      <Old />');
});

test('parseUnifiedDiff: binary detection', () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.equal(files[1].binary, true);
  assert.equal(files[1].additions, 0);
});

test('renderDiffDigest: contains file headers and line numbers', () => {
  const files = parseUnifiedDiff(SAMPLE);
  const digest = renderDiffDigest(files);
  assert.ok(digest.includes('=== FILE: src/App.js'));
  assert.ok(digest.includes('+11:'));
  assert.ok(digest.includes('=== FILE: public/logo.png (binary) ==='));
});

test('parseUnifiedDiff: empty input', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
  assert.deepEqual(parseUnifiedDiff(null), []);
});
