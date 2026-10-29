// v0.43.0 — the §10 cloud plane: cloud resource management.
//
// Units pinned on injectable probes/runners so everything runs offline;
// the LIVE leg runs status against the REAL machine and asserts the CONTRACT,
// not the machine shape: every CLI gets a line matching reality (present →
// version + explicit auth outcome; absent → not on PATH), and credential
// VALUES never surface. CI runners ship aws/gcloud/az — the v0.43.0 test
// assumed a bare machine and broke there while the TOOL stayed honest.
// REAL > SIMULATED, on any machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  tsvTable, probeCloud, findDeployDir, runCloud, createCloudTool,
  BUCKET_RE, CONTAINER_RE, REGION_RE, PROJECT_RE,
} from '../src/tools/cloud.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v043-'));
const noClis = () => ({ aws: null, gcloud: null, az: null });
const fakeClis = (o = {}) => ({ aws: 'aws-cli/2.17.0', gcloud: 'Google Cloud SDK 489.0.0', az: 'azure-cli 2.61.0', ...o });

function dispatchRunner(handlers) {
  return (argv) => {
    const key = argv.slice(0, 3).join(' ');
    const h = handlers.find(([match]) => (typeof match === 'string' ? key.startsWith(match) : match(argv)));
    if (!h) return { status: 99, stdout: '', stderr: `unexpected command: ${argv.join(' ')}` };
    return typeof h[1] === 'function' ? h[1](argv) : h[1];
  };
}

// ── tables + regexes ─────────────────────────────────────────────────────────

test('cloud: tsvTable builds a capped pipe table and renders empty honestly', () => {
  assert.equal(tsvTable('', ['a', 'b']), '(no rows)');
  const t = tsvTable('i-1\tt3.micro\trunning\t1.2.3.4\ni-2\tt4.small\tstopped\t', ['instance', 'type', 'state', 'ip']);
  assert.match(t, /instance \| type \| state \| ip/);
  assert.match(t, /i-1 \| t3\.micro \| running \| 1\.2\.3\.4/);
  assert.match(t, /i-2 \| t4\.small \| stopped \| —/);
  const many = tsvTable(Array.from({ length: 60 }, (_, i) => `r${i}\tx`).join('\n'), ['a', 'b']);
  assert.match(many, /… 10 more rows/);
});

test('cloud: name regexes accept real shapes and refuse shell metacharacters', () => {
  assert.ok(BUCKET_RE.test('my-bucket.example.com'));
  assert.ok(!BUCKET_RE.test('Bad_Bucket'));
  assert.ok(!BUCKET_RE.test('-leading'));
  assert.ok(!BUCKET_RE.test('a'));
  assert.ok(CONTAINER_RE.test('webapp1'));
  assert.ok(!CONTAINER_RE.test('ab'));
  assert.ok(!CONTAINER_RE.test('has space'));
  assert.ok(REGION_RE.test('us-east-1'));
  assert.ok(!REGION_RE.test('us;east'));
  assert.ok(PROJECT_RE.test('buddy-drill-0'));
  assert.ok(!PROJECT_RE.test('x'));
});

// ── probe + deploy dir containment ───────────────────────────────────────────

test('cloud: probeCloud is injectable and reports per-CLI presence', () => {
  assert.deepEqual(probeCloud('/x', () => fakeClis()), fakeClis());
  assert.deepEqual(probeCloud('/x', () => noClis()), noClis());
});

test('cloud: findDeployDir contains the path AND the realpath (symlink escape refused)', () => {
  const root = tmp();
  assert.match(findDeployDir(root, null).error, /deploy needs/);
  fs.mkdirSync(path.join(root, 'site'));
  assert.equal(findDeployDir(root, 'site/').ok, true);
  assert.match(findDeployDir(root, '../evil').error, /escapes the project root/);
  assert.match(findDeployDir(root, '/etc').error, /escapes the project root/);
  assert.match(findDeployDir(root, 'nope').error, /not found/);
  fs.mkdirSync(path.join(root, 'linkdir'));
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside? no — inside');
  fs.symlinkSync(root, path.join(root, 'linkdir', 'loop'));
  // a symlink pointing outside the root:
  const outside = tmp();
  fs.symlinkSync(outside, path.join(root, 'linkdir', 'out'));
  assert.match(findDeployDir(root, 'linkdir/out').error, /symlink/);
});

// ── status: honesty + auth + env hygiene ─────────────────────────────────────

test('cloud: status is honest when no CLIs exist — nothing fake is reported', () => {
  const out = runCloud({ action: 'status' }, { root: tmp(), probe: noClis });
  assert.match(out, /aws: not on PATH/);
  assert.match(out, /gcloud: not on PATH/);
  assert.match(out, /az: not on PATH/);
  assert.match(out, /nothing fake is reported/);
  assert.match(out, /values are never printed/);
});

test('cloud: status env hints show NAMES only — credential values never surface', () => {
  const env = {
    AWS_ACCESS_KEY_ID: 'AKIA-SECRET-VALUE-XYZ', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-secret',
    AWS_SESSION_TOKEN: 'FwoGZXIvYXdzE-secret', AWS_REGION: 'us-east-1', AWS_PROFILE: 'drill',
    GOOGLE_APPLICATION_CREDENTIALS: '/home/me/very-secret-dir/sa.json',
  };
  const out = runCloud({ action: 'status' }, { root: tmp(), probe: noClis, env });
  assert.match(out, /AWS_ACCESS_KEY_ID set/);
  assert.match(out, /AWS_REGION: us-east-1/);
  assert.match(out, /AWS_PROFILE: drill/);
  assert.match(out, /sa\.json/);
  assert.ok(!out.includes('AKIA-SECRET-VALUE-XYZ'), 'key value leaked!');
  assert.ok(!out.includes('wJalrXUtnFEMI-secret'), 'secret value leaked!');
  assert.ok(!out.includes('FwoGZXIvYXdzE-secret'), 'token value leaked!');
  assert.ok(!out.includes('very-secret-dir'), 'credential dir path leaked!');
});

test('cloud: status renders aws identity through sts get-caller-identity', () => {
  const runner = dispatchRunner([
    ['aws sts', { status: 0, stdout: JSON.stringify({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/drill', UserId: 'AIDA drill' }), stderr: '' }],
  ]);
  const out = runCloud({ action: 'status' }, { root: tmp(), probe: () => fakeClis({ gcloud: null, az: null }), runner });
  assert.match(out, /aws: aws-cli\/2\.17\.0/);
  assert.match(out, /aws identity: account 123456789012 · arn:aws:iam::123456789012:user\/drill/);
  assert.match(out, /gcloud: not on PATH/);
});

test('cloud: status reports unauthenticated honestly (all three providers)', () => {
  const runner = () => ({ status: 1, stdout: '', stderr: 'Unable to locate credentials' });
  const out = runCloud({ action: 'status' }, { root: tmp(), probe: fakeClis, runner });
  assert.match(out, /aws: not authenticated \(sts get-caller-identity failed\)/);
  assert.match(out, /gcloud: config list failed/);
  assert.match(out, /az: not logged in \(account show failed/);
});

test('cloud: status renders gcloud + az identities when present', () => {
  const runner = dispatchRunner([
    ['gcloud config', { status: 0, stdout: 'drill@example.com,buddy-drill-0\n', stderr: '' }],
    ['az account', { status: 0, stdout: JSON.stringify({ name: 'Drill Sub', id: 'sub-abc-123', user: 'drill@example.com' }), stderr: '' }],
  ]);
  const out = runCloud({ action: 'status' }, { root: tmp(), probe: fakeClis, runner });
  assert.match(out, /gcloud identity: drill@example\.com · project buddy-drill-0/);
  assert.match(out, /az identity: Drill Sub · sub-abc-123 · drill@example\.com/);
  const noAcct = runCloud({ action: 'status' }, { root: tmp(), probe: () => fakeClis({ aws: null, az: null }), runner: () => ({ status: 0, stdout: ',\n', stderr: '' }) });
  assert.match(noAcct, /gcloud: not authenticated/);
});

// ── list: whitelisted inventories ────────────────────────────────────────────

test('cloud: list aws s3 pins the exact argv and caps raw output', () => {
  let captured;
  const runner = (argv) => { captured = argv; return { status: 0, stdout: '2026-10-28 19:00:00 buddy-drill-bucket\n2026-10-29 08:00:00 buddy-other-bucket\n', stderr: '' }; };
  const out = runCloud({ action: 'list', provider: 'aws', service: 's3' }, { root: tmp(), probe: fakeClis, runner });
  assert.match(out, /aws s3:/);
  assert.match(out, /buddy-drill-bucket/);
  assert.deepEqual(captured, ['aws', 's3', 'ls']);
  const outR = runCloud({ action: 'list', provider: 'aws', service: 's3', region: 'us-west-2' }, { root: tmp(), probe: fakeClis, runner });
  assert.deepEqual(captured, ['aws', 's3', 'ls', '--region', 'us-west-2']);
  const empty = runCloud({ action: 'list', provider: 'aws', service: 's3' }, { root: tmp(), probe: fakeClis, runner: () => ({ status: 0, stdout: '', stderr: '' }) });
  assert.match(empty, /ok \(no s3 resources found\)/);
});

test('cloud: list aws ec2 + lambda render TSV tables', () => {
  const runner = dispatchRunner([
    ['aws ec2', { status: 0, stdout: 'i-0abc\tt3.micro\trunning\t1.2.3.4\n', stderr: '' }],
    ['aws lambda', { status: 0, stdout: 'drill-fn\tnodejs22.x\t2026-10-28T19:00:00Z\n', stderr: '' }],
  ]);
  const ec2 = runCloud({ action: 'list', provider: 'aws', service: 'ec2', region: 'eu-west-1' }, { root: tmp(), probe: fakeClis, runner });
  assert.match(ec2, /instance \| type \| state \| public ip/);
  assert.match(ec2, /i-0abc \| t3\.micro \| running \| 1\.2\.3\.4/);
  const fn = runCloud({ action: 'list', provider: 'aws', service: 'lambda' }, { root: tmp(), probe: fakeClis, runner });
  assert.match(fn, /function \| runtime \| last modified/);
  assert.match(fn, /drill-fn \| nodejs22\.x/);
});

test('cloud: list refuses junk providers/services/regions/projects and missing CLIs', () => {
  const root = tmp();
  const badProvider = runCloud({ action: 'list', provider: 'gcp; rm -rf /', service: 'compute' }, { root, probe: fakeClis });
  assert.match(badProvider, /ERROR: provider must be one of aws, gcp, azure/);
  const badSvc = runCloud({ action: 'list', provider: 'aws', service: 'iam list-roles --output json' }, { root, probe: fakeClis });
  assert.match(badSvc, /ERROR: service must be one of s3, ec2, lambda/);
  const badRegion = runCloud({ action: 'list', provider: 'aws', service: 's3', region: 'us; curl evil' }, { root, probe: fakeClis });
  assert.match(badRegion, /ERROR: bad region/);
  const badProject = runCloud({ action: 'list', provider: 'gcp', service: 'compute', project: '../evil' }, { root, probe: fakeClis });
  assert.match(badProject, /ERROR: bad project id/);
  const noCli = runCloud({ action: 'list', provider: 'azure', service: 'vm' }, { root, probe: noClis });
  assert.match(noCli, /ERROR: az is not on PATH/);
  assert.match(noCli, /nothing fake is reported/);
  let captured;
  const gcpList = runCloud({ action: 'list', provider: 'gcp', service: 'compute', project: 'buddy-drill-0' }, { root, probe: fakeClis, runner: (a) => { captured = a; return { status: 0, stdout: 'vm-1  us-central1-a  RUNNING', stderr: '' }; } });
  assert.deepEqual(captured, ['gcloud', 'compute', 'instances', 'list', '--project', 'buddy-drill-0']);
});

// ── deploy: gated, whitelisted, contained ────────────────────────────────────

test('cloud: deploy aws sync pins argv, requires --delete opt-in', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'site'));
  fs.writeFileSync(path.join(root, 'site/index.html'), '<h1>ok</h1>');
  let captured;
  const cap = (argv) => { captured = argv; return { status: 0, stdout: 'upload: site/index.html', stderr: '' }; };
  const out = runCloud({ action: 'deploy', provider: 'aws', dir: 'site/', bucket: 'buddy-drill-bucket', prefix: 'www' }, { root, probe: fakeClis, runner: cap });
  assert.match(out, /deploy ok — s3 sync site → s3:\/\/buddy-drill-bucket\/www/);
  assert.deepEqual(captured, ['aws', 's3', 'sync', path.join(root, 'site'), 's3://buddy-drill-bucket/www']);
  runCloud({ action: 'deploy', provider: 'aws', dir: 'site/', bucket: 'buddy-drill-bucket', delete: true }, { root, probe: fakeClis, runner: cap });
  assert.deepEqual(captured, ['aws', 's3', 'sync', path.join(root, 'site'), 's3://buddy-drill-bucket', '--delete']);
  // flag smuggling: any truthy junk that is not exactly true/'true' is ignored
  runCloud({ action: 'deploy', provider: 'aws', dir: 'site/', bucket: 'buddy-drill-bucket', delete: 'yes --force' }, { root, probe: fakeClis, runner: cap });
  assert.ok(!captured.includes('--delete'), 'delete flag smuggled through a truthy string!');
});

test('cloud: deploy gcp rsync + azure upload-batch pin argv', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'site'));
  let captured;
  const cap = (argv) => { captured = argv; return { status: 0, stdout: 'ok', stderr: '' }; };
  const g = runCloud({ action: 'deploy', provider: 'gcp', dir: 'site/', bucket: 'buddy-drill-bucket', prefix: 'v43' }, { root, probe: fakeClis, runner: cap });
  assert.match(g, /deploy ok — storage rsync site → gs:\/\/buddy-drill-bucket\/v43/);
  assert.deepEqual(captured, ['gcloud', 'storage', 'rsync', '--recursive', path.join(root, 'site'), 'gs://buddy-drill-bucket/v43']);
  const a = runCloud({ action: 'deploy', provider: 'azure', dir: 'site/', container: 'wwwroot' }, { root, probe: fakeClis, runner: cap });
  assert.match(a, /deploy ok — blob upload-batch site → container wwwroot/);
  assert.deepEqual(captured, ['az', 'storage', 'blob', 'upload-batch', '--destination', 'wwwroot', '--source', path.join(root, 'site')]);
});

test('cloud: deploy refuses bad buckets/containers/prefixes/dirs and missing CLIs', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'site'));
  const p = fakeClis;
  const mk = (args) => runCloud({ action: 'deploy', dir: 'site/', ...args }, { root, probe: p });
  assert.match(mk({ provider: 'aws', bucket: 'S3://evil' }), /ERROR: bad bucket name/);
  assert.match(mk({ provider: 'aws', bucket: 'a..b' }), /ERROR: bad bucket name/);
  assert.match(mk({ provider: 'gcp', bucket: 'x/../y' }), /ERROR: bad bucket name/);
  assert.match(mk({ provider: 'azure', container: 'ab' }), /ERROR: bad container name/);
  assert.match(mk({ provider: 'azure', container: 'a--b' }), /ERROR: bad container name/);
  assert.match(mk({ provider: 'aws', bucket: 'ok-bucket', prefix: '../secret' }), /ERROR: bad prefix/);
  assert.match(mk({ provider: 'aws', bucket: 'ok-bucket', prefix: 'a/b/../../c' }), /ERROR: bad prefix/);
  const noDir = runCloud({ action: 'deploy', provider: 'aws', dir: 'nope', bucket: 'ok-bucket' }, { root, probe: p });
  assert.match(noDir, /ERROR: deploy dir not found/);
  const escape = runCloud({ action: 'deploy', provider: 'aws', dir: '../evil', bucket: 'ok-bucket' }, { root, probe: p });
  assert.match(escape, /ERROR: deploy dir escapes the project root/);
  const noCli = runCloud({ action: 'deploy', provider: 'aws', dir: 'site/', bucket: 'ok-bucket' }, { root, probe: noClis });
  assert.match(noCli, /ERROR: aws is not on PATH/);
  assert.match(noCli, /nothing fake is reported/);
});

test('cloud: spawn failures surface honestly, not as "exited null"', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'site'));
  const out = runCloud(
    { action: 'deploy', provider: 'aws', dir: 'site/', bucket: 'ok-bucket' },
    { root, probe: fakeClis, runner: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' }) }) },
  );
  assert.match(out, /could not run aws: spawn aws ENOENT/);
  assert.match(out, /is aws on PATH\?/);
});

// ── gating + registration + the LIVE leg ─────────────────────────────────────

test('cloud: riskyWhen + registration — inspect gate-free, deploy gated, tool listed', () => {
  const tool = createCloudTool({ root: tmp() });
  assert.equal(tool.name, 'cloud');
  assert.equal(tool.riskyWhen({ action: 'status' }), false);
  assert.equal(tool.riskyWhen({ action: 'list' }), false);
  assert.equal(tool.riskyWhen({ action: 'deploy' }), true);
  assert.match(tool.render({ action: 'deploy', provider: 'gcp', dir: 'site/', bucket: 'b' }), /cloud deploy gcp site\/ → b/);
  const unknown = runCloud({ action: 'terminate' }, { root: tmp(), probe: fakeClis });
  assert.match(unknown, /ERROR: unknown action/);
  const scope = new LocalScope(tmp());
  const names = buildLocalTools({ scope }).map((t) => t.name);
  assert.ok(names.includes('cloud'), 'cloud tool registered');
});

test('cloud: LIVE status against the real machine — the honesty contract on ANY machine', () => {
  const out = runCloud({ action: 'status' }, { root: tmp() }); // NO probe injection — real PATH probe
  assert.match(out, /cloud status/);
  // credential ENV hints: the NAMES always surface, marked names-only — and the
  // leak guard is LIVE: a set credential var's VALUE bytes never appear.
  assert.match(out, /credential env: AWS_ACCESS_KEY_ID/);
  assert.match(out, /names only — values are never printed/);
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
    const v = String(process.env[k] ?? '').trim();
    if (v) assert.ok(!out.includes(v), `credential value of ${k} leaked into the status output`);
  }
  // Per-CLI honesty, TRI-STATE and race-free (CI runners SHIP aws/gcloud/az and
  // gcloud's cold start can exceed the probe timeout — a TIMED-OUT probe must
  // never be reported as "not on PATH", that would be a lie):
  //   version line            → present + talking → an explicit auth outcome exists
  //   "probe failed or timed" → ON PATH, slow/broken → still an explicit auth outcome
  //   "not on PATH"           → ABSENT (ENOENT is deterministic) → "nothing fake";
  //                             cross-checked: a binary that answers --version can
  //                             never be honestly reported absent.
  const lines = out.split('\n');
  const realVersion = (bin) => {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 12000 });
      return r.status === 0 && String(r.stdout || '').trim() ? 'ok' : 'not-ok';
    } catch { return 'not-ok'; }
  };
  for (const bin of ['aws', 'gcloud', 'az']) {
    const line = lines.find((l) => l.startsWith(`${bin}: `));
    assert.ok(line, `${bin} always gets a status line — present, probe-failed, or absent; never silently skipped`);
    if (line.includes('not on PATH')) {
      assert.match(line, /nothing fake is reported/, `${bin} absence is honest, not guessed`);
      assert.equal(realVersion(bin), 'not-ok', `${bin} claimed ABSENT but --version succeeded — the probe lied`);
    } else {
      const auth = lines.find((l) => l !== line && (l.startsWith(`${bin}: `) || l.includes(`${bin} identity:`)));
      assert.ok(auth, `${bin} present (or probe-failed) → an explicit auth outcome (identity or honest failure)`);
    }
  }
});

test('cloud: a timed-out probe is reported as PRESENT-but-slow, never as "not on PATH"', () => {
  // the CI lesson (v0.45.0): gcloud cold start > 8s on GitHub runners — the old
  // probe collapsed "slow" into "absent", which is exactly the lie this pins out
  const out = runCloud({ action: 'status' }, { root: tmp(), probe: () => ({ aws: null, gcloud: 'probe-failed', az: null }) });
  assert.match(out, /gcloud: ON PATH but the --version probe failed or timed out/);
  assert.ok(!/gcloud: not on PATH/.test(out), 'a slow probe must never be reported as absent');
  assert.match(out, /gcloud: (not authenticated|config list failed|identity:)/, 'the auth outcome is still attempted + reported honestly');
  // and list/deploy still treat present-but-slow as present (gated as usual)
  const lst = runCloud({ action: 'list', provider: 'gcp', service: 'storage' }, { root: tmp(), probe: () => ({ aws: null, gcloud: 'probe-failed', az: null }), runner: () => ({ status: 0, stdout: 'gs://bucket-x', stderr: '' }) });
  assert.match(lst, /gcp storage:/);
});
