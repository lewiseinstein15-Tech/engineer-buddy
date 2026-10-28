// v0.38.0 — §9 sandbox mode: bash runs with the network OFF (Linux user+net
// namespace via `unshare -rn`) and HOME restricted to an empty sandbox dir.
// Part A: the pure half — prefix, env, capability probe, args, status, the
// docker/podman strong-option profile.
// Part B: runBash sandbox threading — live integration, capability-gated.
// Part C: tool wiring — live description getter, observation tags, overrides.
// Part D: REPL wiring — registry, settings persistence, source asserts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sandboxPrefix, sandboxEnvOverrides, detectSandboxCapability, ensureSandboxHome,
  makeSandboxContext, parseSandboxArgs, renderSandboxStatus, dockerProfile,
} from '../src/tools/sandbox.js';
import { LocalScope, buildLocalTools, runBash } from '../src/tools/local.js';
import { setChatSetting, getChatSetting } from '../src/settings.js';
import { SLASH_COMMANDS, SLASH_DESCRIPTIONS } from '../src/terminal/repl.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v038-'));
}

// The live capability decides whether Part B integration tests run here.
const LIVE_CAP = detectSandboxCapability();

// ── Part A: the pure half ────────────────────────────────────────────────────

test('sandboxPrefix: linux wraps with unshare -rn, other platforms refuse honestly', () => {
  assert.equal(sandboxPrefix('linux'), 'unshare -rn');
  assert.equal(sandboxPrefix('darwin'), null);
  assert.equal(sandboxPrefix('win32'), null);
});

test('sandboxEnvOverrides: HOME swapped to the sandbox dir, SANDBOX marker set', () => {
  const env = sandboxEnvOverrides('/proj/.buddy/sandbox/home');
  assert.equal(env.HOME, '/proj/.buddy/sandbox/home');
  assert.equal(env.SANDBOX, '1');
  assert.equal(Object.keys(env).length, 2, 'only the overrides — base env merged at spawn time');
});

test('detectSandboxCapability: probe exit 0 → unshare capability', () => {
  const cap = detectSandboxCapability({ run: () => ({ status: 0 }) });
  assert.deepEqual(cap, { ok: true, kind: 'unshare', detail: 'unshare -rn verified on this machine' });
});

test('detectSandboxCapability: probe failure degrades honestly with the reason', () => {
  const cap = detectSandboxCapability({ run: () => ({ status: 1 }) });
  assert.equal(cap.ok, false);
  assert.equal(cap.kind, 'none');
  assert.match(cap.detail, /unshare -rn unusable here \(exit 1\)/);
  const capErr = detectSandboxCapability({ run: () => ({ status: null, error: new Error('EPERM') }) });
  assert.match(capErr.detail, /EPERM/);
  assert.equal(capErr.ok, false);
});

test('detectSandboxCapability: non-linux says Linux-only up front', () => {
  const cap = detectSandboxCapability({ platform: 'darwin' });
  assert.equal(cap.ok, false);
  assert.match(cap.detail, /Linux-only \(this is darwin\)/);
});

test('parseSandboxArgs: empty=status, on/off/profile pass, junk gets usage', () => {
  assert.deepEqual(parseSandboxArgs(''), { action: 'status' });
  assert.deepEqual(parseSandboxArgs('on'), { action: 'on' });
  assert.deepEqual(parseSandboxArgs('OFF'), { action: 'off' });
  assert.deepEqual(parseSandboxArgs(' profile '), { action: 'profile' });
  const bad = parseSandboxArgs('now');
  assert.equal(bad.error, 'unknown argument "now" — /sandbox · /sandbox on · /sandbox off · /sandbox profile');
});

test('renderSandboxStatus: off shows the way in; on names netns + home; degraded says UNAVAILABLE', () => {
  const root = tmpRoot();
  const ctx = makeSandboxContext(root, { probe: () => ({ status: 0 }) });
  const off = renderSandboxStatus(ctx);
  assert.match(off, /sandbox: off/);
  assert.match(off, /\/sandbox on/);

  ctx.enabled = true;
  const on = renderSandboxStatus(ctx);
  assert.match(on, /sandbox: ON/);
  assert.match(on, /off \(netns: unshare -rn\)/);
  assert.match(on, /\.buddy\/sandbox\/home \(empty sandbox dir/);

  const degraded = makeSandboxContext(tmpRoot(), { probe: () => ({ status: 1 }) });
  degraded.enabled = true;
  const deg = renderSandboxStatus(degraded);
  assert.match(deg, /UNAVAILABLE — network NOT isolated/);
  assert.match(deg, /user namespaces may be disabled/);
  assert.match(deg, /restricted HOME still applies/);
});

test('dockerProfile: the strong option is a real docker AND podman command with the boundary spelled out', () => {
  const p = dockerProfile({ root: '/work/proj' });
  assert.match(p, /docker run --rm -it --network none/);
  assert.match(p, /podman run --rm -it --network none/);
  assert.match(p, /-v \/work\/proj:\/work/);
  assert.match(p, /-e HOME=\/tmp\/sandbox-home/);
  assert.match(p, /stronger than the netns sandbox/);
  assert.match(p, /git_write push and web tools intentionally fail/);
});

test('makeSandboxContext: disabled → null overrides; enabled → prefix + env; home dir exists on disk', () => {
  const root = tmpRoot();
  const ctx = makeSandboxContext(root, { probe: () => ({ status: 0 }) });
  assert.equal(ctx.enabled, false);
  assert.equal(ctx.spawnOverrides(), null);
  ctx.enabled = true;
  const o = ctx.spawnOverrides();
  assert.equal(o.prefix, 'unshare -rn');
  assert.equal(o.env.HOME, path.join(root, '.buddy', 'sandbox', 'home'));
  assert.ok(fs.existsSync(ctx.home), 'sandbox home created at context build');
});

test('makeSandboxContext with a failed probe: enabled still restricts HOME, prefix null, honest', () => {
  const ctx = makeSandboxContext(tmpRoot(), { platform: 'linux', probe: () => ({ status: 1 }) });
  ctx.enabled = true;
  const o = ctx.spawnOverrides();
  assert.equal(o.prefix, null, 'no netns without a verified probe');
  assert.ok(o.env.HOME.endsWith('sandbox/home'), 'HOME restriction survives degradation');
  assert.equal(ctx.capability.ok, false);
});

// ── Part B: runBash sandbox threading (live, capability-gated) ──────────────

test('runBash + sandbox: HOME lands in the sandbox dir, flags flow, marker env set', { skip: LIVE_CAP.ok ? false : 'namespace sandbox unavailable on this machine' }, async () => {
  const root = tmpRoot();
  const ctx = makeSandboxContext(root, { probe: () => ({ status: 0 }) });
  ctx.enabled = true;
  const r = await runBash('printenv HOME', { cwd: '/tmp', sandbox: ctx.spawnOverrides() });
  assert.equal(r.ok, true);
  assert.equal(r.stdout.trim(), ctx.home);
  assert.equal(r.sandboxed, true);
  assert.equal(r.netOff, true);
  const marker = await runBash('printenv SANDBOX', { cwd: '/tmp', sandbox: ctx.spawnOverrides() });
  assert.equal(marker.stdout.trim(), '1');
});

test('runBash + sandbox: DNS fails fast inside the namespace (network is OFF)', { skip: LIVE_CAP.ok ? false : 'namespace sandbox unavailable on this machine' }, async () => {
  const ctx = makeSandboxContext(tmpRoot(), { probe: () => ({ status: 0 }) });
  ctx.enabled = true;
  const t0 = Date.now();
  const r = await runBash('getent hosts example.com', { cwd: '/tmp', sandbox: ctx.spawnOverrides(), timeoutMs: 30000 });
  assert.equal(r.ok, false, 'getent must fail with no network');
  assert.ok(r.durationMs < 5000, `DNS must fail instantly, not hang (took ${r.durationMs}ms)`);
});

test('runBash + sandbox: local work still runs — node executes, files map to the real user', { skip: LIVE_CAP.ok ? false : 'namespace sandbox unavailable on this machine' }, async () => {
  const root = tmpRoot();
  const ctx = makeSandboxContext(root, { probe: () => ({ status: 0 }) });
  ctx.enabled = true;
  const r = await runBash('node --version', { cwd: '/tmp', sandbox: ctx.spawnOverrides() });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /^v\d+\./);
  // A file created as mapped-root inside the ns must be owned by the real
  // user outside — no root-owned litter in the project.
  const created = await runBash('touch sbx-own-test', { cwd: root, sandbox: ctx.spawnOverrides() });
  assert.equal(created.ok, true);
  const owner = await runBash('stat -c %U sbx-own-test', { cwd: root });
  assert.notEqual(owner.stdout.trim(), 'root');
  fs.unlinkSync(path.join(root, 'sbx-own-test'));
});

test('runBash without sandbox: no sandboxed flag, byte-stable result shape', async () => {
  const r = await runBash('node --version', { cwd: '/tmp' });
  assert.equal(r.ok, true);
  assert.equal(r.sandboxed, undefined);
  assert.equal(r.netOff, undefined);
});

test('runBash + sandbox: the policy blocklist still runs FIRST — sandbox never widens anything', async () => {
  const ctx = makeSandboxContext(tmpRoot(), { probe: () => ({ status: 0 }) });
  ctx.enabled = true;
  const r = await runBash('echo $HOME', { cwd: '/tmp', sandbox: ctx.spawnOverrides() });
  assert.equal(r.blocked, true, 'command substitution stays blocked under sandbox');
  assert.match(r.stderr, /^BLOCKED:/);
});

// ── Part C: tool wiring ──────────────────────────────────────────────────────

test('bash tool description is LIVE: toggling sandbox.enabled rewrites the very next prompt', () => {
  const root = tmpRoot();
  const scope = new LocalScope(root);
  const ctx = makeSandboxContext(root, { probe: () => ({ status: 0 }) });
  const tools = buildLocalTools({ scope, sandbox: ctx });
  const bash = tools.find((t) => t.name === 'bash');
  const base = bash.description;
  assert.doesNotMatch(base, /SANDBOX IS ON/);
  ctx.enabled = true;
  assert.match(bash.description, /SANDBOX IS ON: every run has NO network/);
  assert.match(bash.description, /HOME is an empty sandbox dir/);
  ctx.enabled = false;
  assert.equal(bash.description, base, 'toggle off restores the exact base description');
});

test('bash tool run: observation carries the sandbox tag only when the sandbox bound', { skip: LIVE_CAP.ok ? false : 'namespace sandbox unavailable on this machine' }, async () => {
  const root = tmpRoot();
  const scope = new LocalScope(root);
  const ctx = makeSandboxContext(root, { probe: () => ({ status: 0 }) });
  const tools = buildLocalTools({ scope, sandbox: ctx });
  const bash = tools.find((t) => t.name === 'bash');

  const plain = await bash.run({ command: 'node --version' });
  assert.doesNotMatch(plain, /\[sandbox/, 'plain runs stay byte-identical to pre-sandbox output');

  ctx.enabled = true;
  const on = await bash.run({ command: 'node --version' });
  assert.match(on, /^\[?\]?exit 0/);
  assert.match(on, /\[sandbox: net off · home restricted\]/);
  assert.match(on, /v\d+\./);
});

// ── Part D: REPL + settings wiring ───────────────────────────────────────────

test('/sandbox is a registered slash command with a profile-mentioning description', () => {
  assert.ok(SLASH_COMMANDS.includes('sandbox'));
  assert.match(SLASH_DESCRIPTIONS.sandbox, /on \| off \| profile/);
  assert.match(SLASH_DESCRIPTIONS.sandbox, /docker\/podman/);
});

test('sandbox on/off persists through the settings round-trip', () => {
  const root = tmpRoot();
  assert.equal(getChatSetting(root, 'sandbox', false), false, 'default off');
  setChatSetting(root, 'sandbox', true);
  assert.equal(getChatSetting(root, 'sandbox', false), true);
  setChatSetting(root, 'sandbox', false);
  assert.equal(getChatSetting(root, 'sandbox', false), false);
});

test('source asserts: makeScopeAndTools reads the persisted flag, threads the ctx, and the flip is live', () => {
  const repl = fs.readFileSync(new URL('../src/terminal/repl.js', import.meta.url), 'utf8');
  assert.match(repl, /makeSandboxContext\(root\)/, 'context built once per session');
  assert.match(repl, /getChatSetting\(root, 'sandbox', false\) === true/, 'enabled state comes from settings');
  assert.match(repl, /buildLocalTools\(\{ scope, todoState, sandbox \}\)/, 'bash tool sees the ctx');
  assert.match(repl, /setChatSetting\(root, 'sandbox', sandboxCtx\.enabled\)/, '/sandbox persists the flip');
  assert.match(repl, /dockerProfile\(\{ root \}\)/, '/sandbox profile prints the strong option');
  const local = fs.readFileSync(new URL('../src/tools/local.js', import.meta.url), 'utf8');
  assert.match(local, /sandbox\.spawnOverrides\(\)/, 'every bash call consults the live ctx');
  assert.match(local, /SANDBOX IS ON/, 'the model is told the boundary changed');
});
