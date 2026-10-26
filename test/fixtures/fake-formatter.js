// fake-formatter.js — a "formatter" for tests: appends a marker line.
//
// node --test scans everything under test/ — bail ONLY in that case
// (argument-less run with the runner's context marker set). When spawned as
// an actual formatter (argv[2] = target file) it always runs.
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  if (process.env.NODE_TEST_CONTEXT) process.exit(0);
  console.error('usage: node fake-formatter.js <file>');
  process.exit(1);
}
try {
  fs.appendFileSync(file, '\n// formatted by fake-formatter\n', 'utf8');
  process.exit(0);
} catch {
  process.exit(2);
}
