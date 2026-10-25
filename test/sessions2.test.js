// Branch / fork / share / import (v0.21.0) — conversation snapshots, session
// copies, self-contained HTML transcripts, cross-machine session restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SessionRecorder, forkSession, exportHtml, writeHtmlExport, importSession, findSession } from '../src/session.js';
import { SLASH_COMMANDS } from '../src/terminal/repl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'src', 'index.js');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-sess2-'));
}

function fakeSession(root, name) {
  const rec = new SessionRecorder(root, name);
  rec.append({ type: 'user', text: 'first question' });
  rec.append({ type: 'tool', tool: 'fs_read', args: { _preview: 'src/a.js' }, observation: 'FILE src/a.js:\ncontent <here>' });
  rec.append({ type: 'say', text: 'the answer with <html> & "quotes"' });
  rec.append({ type: 'shell', command: 'git status' });
  return rec;
}

test('fork copies the session to a new unique file; original untouched', () => {
  const root = tmpRoot();
  const rec = fakeSession(root, 'original work');
  const fork1 = forkSession(root, rec.path, 'experiment');
  const fork2 = forkSession(root, rec.path, 'experiment'); // name collision → -2
  assert.notEqual(fork1, fork2);
  assert.ok(fs.existsSync(fork1) && fs.existsSync(fork2));
  assert.match(fork2, /experiment-2\.jsonl$/);
  assert.equal(fs.readFileSync(rec.path, 'utf8').length > 0, true, 'original intact');
  // auto-name when none given
  const fork3 = forkSession(root, rec.path, '');
  assert.match(path.basename(fork3), /-fork/);
  // content identical
  assert.equal(fs.readFileSync(fork1, 'utf8'), fs.readFileSync(rec.path, 'utf8'));
});

test('exportHtml is self-contained, escapes HTML, includes every event kind', () => {
  const root = tmpRoot();
  const rec = fakeSession(root, 'html test');
  const html = exportHtml(rec.path, { title: 'My Report' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>My Report<\/title>/);
  assert.ok(!/<link|<script src|url\(http/.test(html), 'no external resources');
  assert.match(html, /first question/);
  assert.match(html, /fs_read/);
  assert.match(html, /git status/);
  // injection firewall: literal HTML in content is escaped
  assert.match(html, /&lt;html&gt;/);
  assert.match(html, /&quot;quotes&quot;/);
  assert.ok(!/<html> &/.test(html.replace(/&lt;html&gt; &amp;/g, '')));
});

test('writeHtmlExport lands in .buddy/exports/ as .html', () => {
  const root = tmpRoot();
  const rec = fakeSession(root, 'shared one');
  const out = writeHtmlExport(root, rec.path);
  assert.match(out, /\.html$/);
  assert.match(out, /[\\/.]exports[\\/]/);
  assert.ok(fs.existsSync(out));
});

test('importSession validates JSONL, copies into sessions/, handles conflicts + junk', () => {
  const root = tmpRoot();
  const src = path.join(os.tmpdir(), `buddy-import-${Date.now()}.jsonl`);
  const rec = new SessionRecorder(root, 'placeholder'); // ensure sessions dir exists
  fs.rmSync(rec.path);
  fs.writeFileSync(src, '{"type":"user","text":"hello from another machine"}\n{"type":"say","text":"hi"}\nnot json at all\n');
  const r1 = importSession(root, src);
  assert.equal(r1.events, 2, 'two good lines counted');
  assert.equal(r1.renamed, false);
  assert.ok(fs.existsSync(r1.target));
  // re-import same name → stamped copy, original kept
  const r2 = importSession(root, src);
  assert.equal(r2.renamed, true);
  assert.notEqual(path.resolve(r1.target), path.resolve(r2.target));
  assert.equal(findSession(root, path.basename(src, '.jsonl')) !== null, true, 'findable via -r');
  // non-session file refused
  const junk = path.join(os.tmpdir(), `buddy-junk-${Date.now()}.txt`);
  fs.writeFileSync(junk, 'plain text, zero json');
  assert.throws(() => importSession(root, junk), /not a session file/);
  // missing file refused
  assert.throws(() => importSession(root, path.join(os.tmpdir(), 'no-such-file-xyz.jsonl')), /cannot read/);
  // already-in-sessions refused
  const rec2 = new SessionRecorder(root, 'inside');
  assert.throws(() => importSession(root, rec2.path), /already in/);
});

test('CLI: buddy import wires the subcommand end to end; bad file exits 2', () => {
  const root = tmpRoot();
  const src = path.join(os.tmpdir(), `buddy-cli-import-${Date.now()}.jsonl`);
  fs.writeFileSync(src, '{"type":"user","text":"shared"}\n');
  const ok = spawnSync(process.execPath, [CLI, 'import', src, '--dir', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /imported 1 events/);
  const bad = spawnSync(process.execPath, [CLI, 'import', src], { encoding: 'utf8' }); // no --dir → cwd repo; already imported name? use junk instead
  void bad;
  const junk = path.join(os.tmpdir(), `buddy-cli-junk-${Date.now()}.txt`);
  fs.writeFileSync(junk, 'nope');
  const fail = spawnSync(process.execPath, [CLI, 'import', junk, '--dir', root], { encoding: 'utf8' });
  assert.equal(fail.status, 2);
  assert.match(fail.stderr, /import failed/);
  const noarg = spawnSync(process.execPath, [CLI, 'import'], { encoding: 'utf8' });
  assert.equal(noarg.status, 2);
});

test('slash palette: branch/fork/share registered (and not shadowing built-ins)', () => {
  for (const cmd of ['branch', 'fork', 'share']) {
    assert.ok(SLASH_COMMANDS.includes(cmd));
    assert.equal(SLASH_COMMANDS.filter((c) => c === cmd).length, 1);
  }
});
