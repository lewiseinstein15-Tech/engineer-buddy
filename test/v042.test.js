// v0.42.0 — the §10 operations plane: browser automation + container orchestration.
//
// Units pinned on injectable probes/runners so everything runs offline;
// the browser driver script is pinned by text + injected-runner contracts;
// the LIVE playwright run executes only when the machine actually has a
// global playwright install (skipped honestly elsewhere) — REAL > SIMULATED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkUrl, parseStep, parseBrowserCall, hasActStep, driverScript,
  probeDriver, runBrowserCall, createBrowserTool, MAX_EVAL, MAX_STEPS,
} from '../src/tools/browser.js';
import {
  findComposeFile, renderDockerPs, probeContainers, runContainers,
  createContainersTool,
} from '../src/tools/containers.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v042-'));
const GLOBAL_PW = '/home/z/.npm-global/lib/node_modules/playwright';

// ── browser: URL safety ──────────────────────────────────────────────────────

test('browser: checkUrl allows http/https/file, SSRF-guards hosts, refuses schemes', () => {
  assert.equal(checkUrl('https://example.com/x').ok, true);
  assert.equal(checkUrl('http://example.com').ok, true);
  const f = checkUrl('file:///tmp/page.html');
  assert.equal(f.ok, true);
  assert.equal(f.scheme, 'file');
  for (const bad of ['http://localhost:3000', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1', 'http://192.168.1.1', 'http://172.16.0.9', 'https://box.internal']) {
    const r = checkUrl(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /blocked/, bad);
  }
  // v0.42.0 red-team regression: WHATWG URL keeps brackets in IPv6 hostnames —
  // the guard must strip them or private/link-local v6 slips through (the
  // shared blockedHost also backs web_fetch/http/schema).
  for (const bad6 of ['http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::1]/']) {
    const r = checkUrl(bad6);
    assert.equal(r.ok, false, bad6);
    assert.match(r.error, /blocked/, bad6);
  }
  for (const [u, why] of [['ftp://x', 'refused'], ['javascript:alert(1)', 'refused'], ['data:text/html,x', 'refused'], ['not a url', 'not a URL'], ['', 'url required']]) {
    const r = checkUrl(u);
    assert.equal(r.ok, false, u);
    assert.match(r.error, new RegExp(why), u);
  }
});

// ── browser: step parsing ────────────────────────────────────────────────────

test('browser: parseStep validates actions, selectors, eval cap, wait cap, screenshot paths', () => {
  const root = tmp();
  const open = parseStep({ action: 'open', url: 'https://example.com' }, { root });
  assert.equal(open.ok, true);
  assert.equal(open.step.url, 'https://example.com/');
  const noSel = parseStep({ action: 'click' }, { root });
  assert.match(noSel.error, /needs a/);
  const longSel = parseStep({ action: 'click', selector: 'x'.repeat(301) }, { root });
  assert.match(longSel.error, /selector too long/);
  const noText = parseStep({ action: 'type', selector: '#x' }, { root });
  assert.match(noText.error, /type needs/);
  const secret = parseStep({ action: 'type', selector: '#pw', text: 'hunter2' }, { root });
  assert.equal(secret.ok, true); // allowed, but the error text teaches the risk
  const bigEval = parseStep({ action: 'eval', js: '1'.repeat(MAX_EVAL + 1) }, { root });
  assert.match(bigEval.error, /eval too long/);
  const capWait = parseStep({ action: 'wait', ms: 99999 }, { root });
  assert.equal(capWait.step.ms, 10000);
  const badShot = parseStep({ action: 'screenshot', path: '../evil.png' }, { root });
  assert.match(badShot.error, /escapes the project root/);
  const badExt = parseStep({ action: 'screenshot', path: 'shot.gif' }, { root });
  assert.match(badExt.error, /\.png or \.jpg/);
  const defShot = parseStep({ action: 'screenshot' }, { root });
  assert.equal(defShot.ok, true);
  assert.match(defShot.step.path, /\.buddy[\\/]browser[\\/]shot-\d+-1\.png$/);
  const unknown = parseStep({ action: 'download' }, { root });
  assert.match(unknown.error, /unknown step action/);
});

test('browser: parseBrowserCall takes direct form and steps list, caps count, clamps viewport', () => {
  const root = tmp();
  const direct = parseBrowserCall({ action: 'screenshot', url: 'https://example.com' }, { root });
  assert.equal(direct.ok, true);
  assert.equal(direct.steps.length, 1);
  const multi = parseBrowserCall({ steps: [{ action: 'open', url: 'https://example.com' }, { action: 'text' }] }, { root });
  assert.equal(multi.viewport.width, 1280);
  assert.equal(multi.viewport.height, 720);
  const tooMany = parseBrowserCall({ steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ action: 'wait', ms: 1 })) }, { root });
  assert.match(tooMany.error, /too many steps/);
  const clamp = parseBrowserCall({ action: 'wait', width: 9999, height: 1 }, { root });
  assert.equal(clamp.viewport.width, 3840);
  assert.equal(clamp.viewport.height, 200);
  const badStep = parseBrowserCall({ steps: [{ action: 'open', url: 'https://ok.com' }, { action: 'open', url: 'http://localhost' }] }, { root });
  assert.match(badStep.error, /step 2/);
  assert.match(badStep.error, /blocked/);
});

test('browser: hasActStep drives riskyWhen — read steps gate-free, page interaction gated', () => {
  assert.equal(hasActStep({ steps: [{ action: 'open', url: 'https://x.com' }, { action: 'screenshot' }] }), false);
  assert.equal(hasActStep({ action: 'click', selector: '#a' }), true);
  assert.equal(hasActStep({ steps: [{ action: 'type', selector: '#q', text: 'hi' }] }), true);
  assert.equal(hasActStep({ steps: [{ action: 'eval', js: '1+1' }] }), true);
  const tool = createBrowserTool({ root: tmp() });
  assert.equal(tool.name, 'browser');
  assert.equal(tool.riskyWhen({ steps: [{ action: 'open', url: 'https://x.com' }] }), false);
  assert.equal(tool.riskyWhen({ steps: [{ action: 'eval', js: '1' }] }), true);
  assert.match(tool.render({ steps: [{ action: 'open', url: 'https://x.com' }, { action: 'screenshot' }] }), /browser open\+screenshot/);
});

// ── browser: driver probe + script contract ──────────────────────────────────

test('browser: probeDriver prefers playwright, falls back to puppeteer, honest null', () => {
  assert.equal(probeDriver('/x', () => 'playwright'), 'playwright');
  assert.equal(probeDriver('/x', () => 'puppeteer'), 'puppeteer');
  assert.equal(probeDriver('/x', () => null), null);
});

test('browser: driverScript resolves the driver from the PROJECT, not from Buddy', () => {
  const s = driverScript({ driver: 'playwright', steps: [{ action: 'screenshot', path: '/tmp/x.png' }], viewport: { width: 800, height: 600 } });
  assert.match(s, /createRequire/);
  assert.match(s, /process\.cwd\(\), 'package\.json'/); // project-rooted resolution
  assert.match(s, /req\('playwright'\)/);
  assert.match(s, /chromium\.launch/);
  assert.match(s, /headless: true/);
  const p = driverScript({ driver: 'puppeteer', steps: [], viewport: {} });
  assert.match(p, /req\('puppeteer'\)/);
  assert.match(p, /setViewport/);
  assert.match(s, /JSON\.parse\(process\.argv\[process\.argv\.length - 1\]/);
});

// ── browser: runBrowserCall contracts (injected runners, offline) ────────────

test('browser: honest refusal when the project has no driver', async () => {
  const out = await runBrowserCall({ action: 'screenshot', url: 'https://example.com' }, { root: tmp(), probe: () => null });
  assert.match(out, /ERROR: no browser driver/);
  assert.match(out, /never bundles browsers/);
  assert.match(out, /npm i -D playwright/);
  assert.match(out, /browser MCP server/);
});

test('browser: observation reports the shot path for the image-input path', async () => {
  const root = tmp();
  const shot = path.join(root, '.buddy/browser', 'shot-1.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const fake = (script, opts) => {
    assert.match(script, /playwright/);
    assert.equal(opts.command.driver, 'playwright');
    return { code: 0, stdout: JSON.stringify({ ok: true, title: 'Demo', url: 'file:///demo.html', steps: [{ i: 0, action: 'open', ok: true }, { i: 1, action: 'screenshot', ok: true }, { i: 2, action: 'text', ok: true }], shots: [shot], text: '  hello   buddy  ' }) + '\n', stderr: '' };
  };
  const out = await runBrowserCall({ steps: [{ action: 'open', url: 'file:///demo.html' }, { action: 'screenshot' }, { action: 'text' }] }, { root, probe: () => 'playwright', runner: fake });
  assert.match(out, /browser ok — Demo — file:\/\/\/demo\.html \(3\/3 steps/);
  assert.match(out, /driver: playwright/);
  assert.match(out, /📸 .*\.buddy[\\/]browser[\\/]shot-1\.png/);
  assert.match(out, /@mention this path to attach/);
  assert.match(out, /hello buddy/);
});

test('browser: a failed step is reported with the steps completed before it', async () => {
  const fake = () => ({ code: 0, stdout: JSON.stringify({ ok: false, error: 'step 2 (click) failed: timeout', steps: [{ i: 0, action: 'open', ok: true }, { i: 1, action: 'click', ok: false, error: 'timeout' }] }) + '\n', stderr: '' });
  const out = await runBrowserCall({ steps: [{ action: 'open', url: 'https://x.com' }, { action: 'click', selector: '#b' }] }, { root: tmp(), probe: () => 'playwright', runner: fake });
  assert.match(out, /ERROR: step 2 \(click\) failed: timeout/);
  assert.match(out, /steps completed before failure: 1/);
});

test('browser: garbage child output is an honest error, not a fake success', async () => {
  const fake = () => ({ code: 1, stdout: 'segfault everywhere', stderr: 'crashed' });
  const out = await runBrowserCall({ action: 'wait' }, { root: tmp(), probe: () => 'puppeteer', runner: fake });
  assert.match(out, /ERROR: the browser driver produced no result — crashed/);
});

// ── browser: the LIVE run (skipped when the machine lacks playwright) ────────

test('browser: LIVE headless run against a local file:// page', { skip: !fs.existsSync(GLOBAL_PW) && 'no global playwright on this machine' }, async () => {
  const root = tmp();
  // Shim: the tmp project "installs" playwright by re-exporting the global one.
  fs.mkdirSync(path.join(root, 'node_modules/playwright'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/playwright/package.json'), JSON.stringify({ name: 'playwright', version: '0.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(root, 'node_modules/playwright/index.js'), `module.exports = require(${JSON.stringify(GLOBAL_PW)});`);
  fs.writeFileSync(path.join(root, 'demo.html'), '<html><head><title>Buddy Live</title></head><body><h1>hello buddy</h1><p id="n">42</p></body></html>');
  const out = await runBrowserCall(
    { steps: [{ action: 'open', url: 'file://' + path.join(root, 'demo.html') }, { action: 'eval', js: 'document.getElementById("n").textContent' }, { action: 'screenshot' }, { action: 'text' }] },
    { root },
  );
  assert.match(out, /browser ok — Buddy Live/);
  assert.match(out, /eval → 42/);
  const m = out.match(/📸 (\S+\.png)/);
  assert.ok(m, 'shot path reported');
  const shotAbs = path.resolve(root, m[1]);
  const buf = fs.readFileSync(shotAbs);
  assert.ok(buf.length > 1000, 'PNG has real bytes');
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic');
});

// ── containers: compose file discovery + containment ─────────────────────────

test('containers: findComposeFile discovers in root, enforces containment, honest misses', () => {
  const root = tmp();
  const miss = findComposeFile(root, null);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /no compose file/);
  fs.writeFileSync(path.join(root, 'compose.yaml'), 'services: {}');
  assert.equal(findComposeFile(root, null).file, path.join(root, 'compose.yaml'));
  fs.rmSync(path.join(root, 'compose.yaml'));
  fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services: {}');
  assert.equal(findComposeFile(root, null).file, path.join(root, 'docker-compose.yml'));
  const explicit = findComposeFile(root, 'deploy/stack.yaml');
  assert.equal(explicit.ok, false);
  assert.match(explicit.error, /not found/);
  fs.mkdirSync(path.join(root, 'deploy'));
  fs.writeFileSync(path.join(root, 'deploy/stack.yaml'), 'services: {}');
  assert.equal(findComposeFile(root, 'deploy/stack.yaml').ok, true);
  const escape = findComposeFile(root, '../evil.yaml');
  assert.match(escape.error, /escapes the project root/);
});

test('containers: renderDockerPs builds a capped pipe table', () => {
  assert.equal(renderDockerPs(''), '(no containers running)');
  const tsv = ['web\tnginx:1.27\tUp 2 minutes\t0.0.0.0:8080->80/tcp', 'db\tpg:17\tUp 2 minutes\t'].join('\n');
  const t = renderDockerPs(tsv);
  assert.match(t, /name \| image \| status \| ports/);
  assert.match(t, /web \| nginx:1\.27 \| Up 2 minutes/);
  assert.match(t, /db \| pg:17/);
  const many = renderDockerPs(Array.from({ length: 60 }, (_, i) => `c${i}\timg\tUp\t`).join('\n'));
  assert.match(many, /… 10 more containers/);
});

// ── containers: runContainers contracts (injected probes/runners, offline) ──

function fakeBins(overrides = {}) {
  return () => ({ docker: 'Docker version 27.3.1', compose: 'Docker Compose version 2.29.7', kubectl: 'kubectl', kind: null, minikube: null, ...overrides });
}
function dispatchRunner(handlers) {
  return (argv) => {
    const key = argv.slice(0, 3).join(' ');
    const h = handlers.find(([match]) => (typeof match === 'string' ? key.startsWith(match) : match(argv)));
    if (!h) return { status: 99, stdout: '', stderr: `unexpected command: ${argv.join(' ')}` };
    return typeof h[1] === 'function' ? h[1](argv) : h[1];
  };
}

test('containers: status is honest when docker is absent — nothing fake is reported', () => {
  const out = runContainers({ action: 'status' }, { root: tmp(), probe: () => ({ docker: null, compose: null, kubectl: null, kind: null, minikube: null }) });
  assert.match(out, /docker: not on PATH/);
  assert.match(out, /nothing fake is reported/);
  assert.match(out, /kubectl: not on PATH/);
});

test('containers: status renders ps table, compose projects, pods, and tool detection', () => {
  const root = tmp();
  const runner = dispatchRunner([
    ['docker ps', { status: 0, stdout: 'web\tnginx\tUp 1m\t:80->80', stderr: '' }],
    ['docker compose ls', { status: 0, stdout: 'stack\trunning(2)\tcompose.yaml', stderr: '' }],
    ['kubectl config', { status: 0, stdout: 'kind-kind\n', stderr: '' }],
    ['kubectl get pods', { status: 0, stdout: 'default\tweb-1\ttrue\tRunning\nkube-system\tdns-1\ttrue\tRunning', stderr: '' }],
  ]);
  const out = runContainers({ action: 'status' }, { root, probe: fakeBins({ kind: 'kind version 0.24.0' }), runner });
  assert.match(out, /docker: Docker version 27\.3\.1 · compose: Docker Compose version 2\.29\.7/);
  assert.match(out, /web \| nginx \| Up 1m/);
  assert.match(out, /compose projects:\nstack \| running\(2\)/);
  assert.match(out, /kubectl: present · context: kind-kind/);
  assert.match(out, /default \| web-1 \| true \| Running/);
  assert.match(out, /kind: kind version 0\.24\.0 · minikube: not found/);
});

test('containers: logs ride compose when a compose file exists, plain docker otherwise', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'compose.yaml'), 'services: {}');
  let captured;
  const runner = (argv) => { captured = argv; return { status: 0, stdout: 'l1\nl2\nl3', stderr: '' }; };
  const out = runContainers({ action: 'logs', services: ['web'], tail: 120 }, { root, probe: fakeBins(), runner });
  assert.match(out, /compose logs — compose\.yaml \(web\) \(last 120 lines\)/);
  assert.match(out, /l1\nl2\nl3/);
  assert.deepEqual(captured, ['docker', 'compose', '-f', path.join(root, 'compose.yaml'), 'logs', '--tail', '120', '--no-color', 'web']);
  const root2 = tmp();
  const out2 = runContainers({ action: 'logs' }, { root: root2, probe: fakeBins(), runner: () => ({ status: 0, stdout: '', stderr: '' }) });
  assert.match(out2, /ERROR: logs need a service/);
  let cap2;
  const runner2 = (argv) => { cap2 = argv; return { status: 0, stdout: 'boot ok', stderr: '' }; };
  const out3 = runContainers({ action: 'logs', services: ['plain-box'] }, { root: root2, probe: fakeBins(), runner: runner2 });
  assert.match(out3, /docker logs — plain-box \(last 80 lines\)/);
  assert.deepEqual(cap2, ['docker', 'logs', '--tail', '80', 'plain-box']);
});

test('containers: compose lifecycle pins whitelisted argv and refuses junk', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'compose.yaml'), 'services: {}');
  const runner = dispatchRunner([
    (a) => a[0] === 'docker', { status: 0, stdout: 'ok', stderr: '' },
  ]);
  let captured;
  const capRunner = (argv) => { captured = argv; return { status: 0, stdout: 'ok', stderr: '' }; };
  const outUp = runContainers({ action: 'up', build: true, services: ['web', 'db'] }, { root, probe: fakeBins(), runner: capRunner });
  assert.match(outUp, /compose up \(detached\) — web, db — ok/);
  assert.deepEqual(captured, ['docker', 'compose', '-f', path.join(root, 'compose.yaml'), 'up', '-d', '--build', 'web', 'db']);
  runContainers({ action: 'down', volumes: true }, { root, probe: fakeBins(), runner: (a) => { captured = a; return { status: 0, stdout: '', stderr: '' }; } });
  assert.deepEqual(captured, ['docker', 'compose', '-f', path.join(root, 'compose.yaml'), 'down', '-v']);
  runContainers({ action: 'restart', services: ['web'] }, { root, probe: fakeBins(), runner: (a) => { captured = a; return { status: 0, stdout: '', stderr: '' }; } });
  assert.deepEqual(captured, ['docker', 'compose', '-f', path.join(root, 'compose.yaml'), 'restart', 'web']);
  runContainers({ action: 'build' }, { root, probe: fakeBins(), runner: (a) => { captured = a; return { status: 0, stdout: '', stderr: '' }; } });
  assert.deepEqual(captured, ['docker', 'compose', '-f', path.join(root, 'compose.yaml'), 'build']);
  const evil = runContainers({ action: 'up', services: ['web; rm -rf /'] }, { root, probe: fakeBins(), runner });
  assert.match(evil, /ERROR: bad service name/);
  const noDocker = runContainers({ action: 'up' }, { root, probe: () => ({ docker: null, compose: null, kubectl: null, kind: null, minikube: null }) });
  assert.match(noDocker, /ERROR: docker is not on PATH/);
  const noPlugin = runContainers({ action: 'up' }, { root, probe: () => ({ docker: 'Docker version 27.3.1', compose: null, kubectl: null, kind: null, minikube: null }) });
  assert.match(noPlugin, /ERROR: the docker compose plugin is not installed/);
  const failed = runContainers({ action: 'up' }, { root, probe: fakeBins(), runner: () => ({ status: 1, stdout: '', stderr: 'port already allocated' }) });
  assert.match(failed, /failed — docker compose exited 1/);
  assert.match(failed, /port already allocated/);
  // v0.42.0 red-team regressions: garbage is REFUSED with a teaching error, and
  // a missing binary is reported honestly instead of "exited null".
  const badTail = runContainers({ action: 'logs', services: ['web'], tail: '80; shutdown now' }, { root, probe: fakeBins() });
  assert.match(badTail, /ERROR: tail must be a number of lines/);
  const exitNull = runContainers({ action: 'logs', services: ['web'] }, { root, probe: fakeBins(), runner: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) }) });
  // this root has a compose.yaml → the compose path runs (and fails) first
  assert.match(exitNull, /could not run docker compose: spawn docker ENOENT/);
  assert.match(exitNull, /is docker compose on PATH\?/);
});

test('containers: deploy applies a contained manifest through kubectl', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'k8s'));
  fs.writeFileSync(path.join(root, 'k8s/app.yaml'), 'apiVersion: v1');
  let captured;
  const capRunner = (argv) => { captured = argv; return { status: 0, stdout: 'deployment.apps/web configured', stderr: '' }; };
  const noKubectl = runContainers({ action: 'deploy', file: 'k8s/app.yaml' }, { root, probe: () => ({ docker: null, compose: null, kubectl: null, kind: null, minikube: null }) });
  assert.match(noKubectl, /ERROR: kubectl is not on PATH/);
  const out = runContainers({ action: 'deploy', file: 'k8s/app.yaml', namespace: 'prod' }, { root, probe: fakeBins(), runner: capRunner });
  assert.match(out, /deploy ok — app\.yaml applied to namespace prod/);
  assert.match(out, /deployment\.apps\/web configured/);
  assert.deepEqual(captured, ['kubectl', 'apply', '-f', path.join(root, 'k8s/app.yaml'), '-n', 'prod']);
  const missing = runContainers({ action: 'deploy', file: 'k8s/none.yaml' }, { root, probe: fakeBins() });
  assert.match(missing, /manifest not found/);
  const escape = runContainers({ action: 'deploy', file: '../evil.yaml' }, { root, probe: fakeBins() });
  assert.match(escape, /escapes the project root/);
  const badNs = runContainers({ action: 'deploy', file: 'k8s/app.yaml', namespace: 'NOT A NS' }, { root, probe: fakeBins() });
  assert.match(badNs, /ERROR: bad namespace/);
  const noFile = runContainers({ action: 'deploy' }, { root, probe: fakeBins() });
  assert.match(noFile, /deploy needs/);
});

test('containers: riskyWhen + registration — reads gate-free, lifecycle gated, tools listed', () => {
  const tool = createContainersTool({ root: tmp() });
  assert.equal(tool.name, 'containers');
  assert.equal(tool.riskyWhen({ action: 'status' }), false);
  assert.equal(tool.riskyWhen({ action: 'logs' }), false);
  for (const a of ['up', 'down', 'restart', 'build', 'deploy']) assert.equal(tool.riskyWhen({ action: a }), true, a);
  assert.match(tool.render({ action: 'up', file: 'compose.yaml', services: ['web'] }), /containers up compose\.yaml \(web\)/);
  const unknown = runContainers({ action: 'exec' }, { root: tmp(), probe: fakeBins() });
  assert.match(unknown, /ERROR: unknown action/);
  const scope = new LocalScope(tmp());
  const tools = buildLocalTools({ scope });
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('browser'), 'browser tool registered');
  assert.ok(names.includes('containers'), 'containers tool registered');
});
