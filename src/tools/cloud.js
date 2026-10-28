// cloud.js — the cloud resource tool (v0.43.0, checklist §10):
// "AWS/GCP/Azure via the repos' own SDKs or MCP servers; cloud tool
//  lists/inspects, never mutates without a gate."
//
// Zero-dep by construction: Buddy shells out to THE MACHINE'S OWN CLIs
// (aws, gcloud, az), probed on PATH at call time — nothing bundled, nothing
// faked. Absent CLI → honest refusal naming what to install; an MCP server
// remains the other route (the existing mcp tool).
//
// Read/act split mirrors the db + containers tools:
//   status — gate-free: which CLIs exist (version lines), who is
//            authenticated (READ-ONLY identity calls: sts get-caller-identity,
//            gcloud config list, az account show), and which credential ENV
//            VARS are set — NAMES only, values never surface (the secret-tool
//            rule; the value bytes must not appear in any transcript).
//   list   — gate-free: ONE whitelisted read-only inventory per provider
//            (aws: s3/ec2/lambda · gcp: compute/storage/run · azure:
//            vm/webapp/storage), capped output; optional --region (aws) /
//            --project (gcp) flags, values validated, never interpolated.
//   deploy — riskyWhen → approval gate: ONE whitelisted upload/sync per
//            provider (aws s3 sync · gcloud storage rsync · az blob
//            upload-batch) of a directory INSIDE the project root
//            (containment + realpath — a symlink pointing out is refused).
// Only whitelisted flags are ever passed. No delete-buckets, no
// terminate-instance, no arbitrary CLI args in v1 — honesty over spectacle.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { truncate } from '../util.js';

export const READ_TIMEOUT_MS = 30000;
export const ACT_TIMEOUT_MS = 300000; // cloud syncs are slower than local runs
const READ_ACTIONS = new Set(['status', 'list']);
const PROVIDERS = new Set(['aws', 'gcp', 'azure']);
export const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
export const CONTAINER_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const REGION_RE = /^[a-z0-9-]{2,32}$/;
export const PROJECT_RE = /^[a-z0-9-]{4,32}$/;
const MAX_LIST_CHARS = 6000;
const MAX_ROWS = 50;

/** Generic TSV → pipe table, capped. Empty input renders honestly. */
export function tsvTable(tsv, headers, { maxRows = MAX_ROWS } = {}) {
  const rows = String(tsv || '').split('\n').map((l) => l.split('\t')).filter((c) => c.some((x) => String(x).trim()));
  if (!rows.length) return '(no rows)';
  const bar = '-'.repeat(46);
  const cell = (s) => truncate(String(s ?? '').trim() || '—', 44);
  let out = `${bar}\n${headers.join(' | ')}\n${bar}`;
  for (const c of rows.slice(0, maxRows)) out += `\n${c.map(cell).join(' | ')}`;
  if (rows.length > maxRows) out += `\n… ${rows.length - maxRows} more rows`;
  return out;
}

/** Probe the machine's own cloud CLIs. Injectable for tests. */
export function probeCloud(root, probe = null) {
  if (probe) return probe(root);
  const check = (bin) => {
    try {
      const r = spawnSync(bin, ['--version'], { cwd: root, encoding: 'utf8', timeout: 8000 });
      const first = String(r.stdout || '').trim().split('\n')[0];
      return r.status === 0 && first ? truncate(first, 60) : null;
    } catch { return null; }
  };
  return { aws: check('aws'), gcloud: check('gcloud'), az: check('az') };
}

/** Run one whitelisted command. Injectable runner keeps tests offline. */
export function runBin(argv, { root, timeoutMs, runner = null }) {
  const fn = runner || ((a, o) => {
    const r = spawnSync(a[0], a.slice(1), { cwd: o.root, timeout: o.timeoutMs, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  });
  return fn(argv, { root, timeoutMs });
}

function honestExit(bin, r, label) {
  if (r.status === null) {
    const reason = truncate(String(r.stderr || r.error?.message || '').trim(), 300) || 'spawn failed';
    return `${label} failed — could not run ${bin}: ${reason}${/ENOENT/i.test(reason) ? ` (is ${bin} on PATH?)` : ''}`;
  }
  const tail = truncate(String(r.stderr || r.stdout || '').trim(), 400);
  return `${label} failed — ${bin} exited ${r.status}${tail ? `\n${tail}` : ''}`;
}

function binFor(provider) {
  return provider === 'gcp' ? 'gcloud' : provider === 'azure' ? 'az' : 'aws';
}

/** Deploy dir: containment (path-level) AND realpath (symlink-level). */
export function findDeployDir(root, dir) {
  const p = String(dir ?? '').trim();
  if (!p) return { ok: false, error: 'deploy needs {"dir":"site/"} — a directory inside the project root' };
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    return { ok: false, error: `deploy dir escapes the project root: ${truncate(p, 80)}` };
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, error: `deploy dir not found (or not a directory): ${truncate(p, 120)}` };
  }
  // red-team hardening: a symlink INSIDE the project pointing OUTSIDE still escapes
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(path.resolve(root) + path.sep) && real !== path.resolve(root)) {
    return { ok: false, error: `deploy dir resolves outside the project root through a symlink: ${truncate(p, 80)}` };
  }
  return { ok: true, dir: real };
}

function checkPrefix(raw) {
  const prefix = String(raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!prefix) return { ok: true, prefix: '' };
  if (!/^[\w./-]{1,200}$/.test(prefix) || /(^|\/)\.\.(\/|$)/.test(prefix)) {
    return { ok: false, error: `bad prefix "${truncate(String(raw), 60)}" — letters/digits/dots/dashes/slashes only, no ".." segments` };
  }
  return { ok: true, prefix };
}

function envHints(env) {
  const set = (k) => (String(env[k] ?? '').trim() ? 'set' : 'unset');
  return [
    `credential env: AWS_ACCESS_KEY_ID ${set('AWS_ACCESS_KEY_ID')} · AWS_SECRET_ACCESS_KEY ${set('AWS_SECRET_ACCESS_KEY')} · AWS_SESSION_TOKEN ${set('AWS_SESSION_TOKEN')} (names only — values are never printed)`,
    `AWS_REGION: ${env.AWS_REGION || env.AWS_DEFAULT_REGION || 'unset'} · AWS_PROFILE: ${env.AWS_PROFILE || 'unset'}`,
    `GOOGLE_APPLICATION_CREDENTIALS: ${env.GOOGLE_APPLICATION_CREDENTIALS ? path.basename(env.GOOGLE_APPLICATION_CREDENTIALS) : 'unset'} · AZURE_CONFIG_DIR: ${set('AZURE_CONFIG_DIR')}`,
  ];
}

const AWS_SERVICES = {
  s3: { argv: (r) => ['aws', 's3', 'ls', ...(r ? ['--region', r] : [])] },
  ec2: {
    headers: ['instance', 'type', 'state', 'public ip'],
    argv: (r) => ['aws', 'ec2', 'describe-instances', '--query', 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name,PublicIpAddress]', '--output', 'text', ...(r ? ['--region', r] : [])],
  },
  lambda: {
    headers: ['function', 'runtime', 'last modified'],
    argv: (r) => ['aws', 'lambda', 'list-functions', '--query', 'Functions[].[FunctionName,Runtime,LastModified]', '--output', 'text', ...(r ? ['--region', r] : [])],
  },
};
const GCP_SERVICES = {
  compute: { argv: (p) => ['gcloud', 'compute', 'instances', 'list', ...(p ? ['--project', p] : [])] },
  storage: { argv: () => ['gcloud', 'storage', 'ls'] },
  run: { argv: (p) => ['gcloud', 'run', 'services', 'list', ...(p ? ['--project', p] : [])] },
};
const AZ_SERVICES = {
  vm: { argv: () => ['az', 'vm', 'list', '--output', 'table'] },
  webapp: { argv: () => ['az', 'webapp', 'list', '--output', 'table'] },
  storage: { argv: () => ['az', 'storage', 'account', 'list', '--output', 'table'] },
};
const SERVICES = { aws: AWS_SERVICES, gcp: GCP_SERVICES, azure: AZ_SERVICES };

/** One cloud tool call → observation string (never throws). */
export function runCloud(args = {}, { root = process.cwd(), probe = null, runner = null, env = process.env } = {}) {
  const action = String(args?.action || 'status').trim().toLowerCase();
  if (!['status', 'list', 'deploy'].includes(action)) {
    return `ERROR: unknown action "${truncate(String(args?.action || ''), 24)}" — known: status, list, deploy`;
  }
  const bins = probeCloud(root, probe);

  // ── status (read): CLIs + auth + credential-env hints (names only) ────────
  if (action === 'status') {
    const lines = ["cloud status — the machine's own CLIs (nothing bundled, nothing faked)"];
    const auth = [];
    if (bins.aws) {
      lines.push(`aws: ${bins.aws}`);
      const id = runBin(['aws', 'sts', 'get-caller-identity', '--output', 'json'], { root, timeoutMs: READ_TIMEOUT_MS, runner });
      if (id.status === 0) {
        try {
          const j = JSON.parse(String(id.stdout || '{}'));
          auth.push(`aws identity: account ${truncate(String(j.Account || '?'), 24)} · ${truncate(String(j.Arn || ''), 70)}`);
        } catch { auth.push('aws: sts responded but not as JSON (reported honestly, not guessed)'); }
      } else {
        auth.push('aws: not authenticated (sts get-caller-identity failed)');
      }
    } else {
      lines.push('aws: not on PATH — install the AWS CLI and retry; nothing fake is reported');
    }
    if (bins.gcloud) {
      lines.push(`gcloud: ${bins.gcloud}`);
      const cfg = runBin(['gcloud', 'config', 'list', '--format=csv[no-heading](core.account,core.project)'], { root, timeoutMs: READ_TIMEOUT_MS, runner });
      if (cfg.status !== 0) {
        auth.push('gcloud: config list failed (not authenticated or SDK incomplete)');
      } else {
        const row = String(cfg.stdout || '').trim().split('\n')[0] || '';
        const [acct, proj] = row.split(',');
        if (acct && acct.trim() && acct.trim() !== '') auth.push(`gcloud identity: ${truncate(acct.trim(), 50)}${proj && proj.trim() ? ` · project ${truncate(proj.trim(), 40)}` : ' · no project set'}`);
        else auth.push('gcloud: not authenticated (no account in config)');
      }
    } else {
      lines.push('gcloud: not on PATH — install the Google Cloud SDK and retry; nothing fake is reported');
    }
    if (bins.az) {
      lines.push(`az: ${bins.az}`);
      const acc = runBin(['az', 'account', 'show', '--output', 'json', '--query', '{name:name,id:id,user:user.name}'], { root, timeoutMs: READ_TIMEOUT_MS, runner });
      if (acc.status === 0) {
        try {
          const j = JSON.parse(String(acc.stdout || '{}'));
          auth.push(`az identity: ${truncate(String(j.name || '?'), 40)} · ${truncate(String(j.id || ''), 44)}${j.user ? ` · ${truncate(String(j.user), 40)}` : ''}`);
        } catch { auth.push('az: account show responded but not as JSON (reported honestly, not guessed)'); }
      } else {
        auth.push('az: not logged in (account show failed — try `az login`)');
      }
    } else {
      lines.push('az: not on PATH — install the Azure CLI and retry; nothing fake is reported');
    }
    lines.push(...envHints(env));
    if (auth.length) lines.push(...auth);
    return lines.join('\n');
  }

  const provider = String(args?.provider || '').trim().toLowerCase();
  if (!PROVIDERS.has(provider)) {
    return `ERROR: provider must be one of aws, gcp, azure — got "${truncate(String(args?.provider ?? ''), 24)}"`;
  }
  const bin = binFor(provider);
  if (!bins[bin]) return `ERROR: ${bin} is not on PATH — install it and retry; nothing fake is reported`;

  // ── list (read): one whitelisted inventory per provider ───────────────────
  if (action === 'list') {
    const map = SERVICES[provider];
    const svc = String(args?.service || '').trim().toLowerCase();
    if (!svc || !map[svc]) {
      return `ERROR: service must be one of ${Object.keys(map).join(', ')} for ${provider} — got "${truncate(String(args?.service ?? ''), 24)}"`;
    }
    const region = args?.region != null ? String(args.region).trim() : null;
    if (region && provider === 'aws' && !REGION_RE.test(region)) {
      return `ERROR: bad region "${truncate(region, 32)}" — regions look like us-east-1`;
    }
    const project = args?.project != null ? String(args.project).trim() : null;
    if (project && provider === 'gcp' && !PROJECT_RE.test(project)) {
      return `ERROR: bad project id "${truncate(project, 32)}" — project ids are lowercase [a-z0-9-]`;
    }
    const flag = provider === 'aws' ? region : provider === 'gcp' ? project : null;
    const r = runBin(map[svc].argv(flag), { root, timeoutMs: READ_TIMEOUT_MS, runner });
    if (r.status !== 0) return honestExit(bin, r, `list ${provider} ${svc}`);
    const out = String(r.stdout || '').trim();
    if (!out) return `list ${provider} ${svc} — ok (no ${svc} resources found)`;
    if (map[svc].headers) return `${provider} ${svc}:\n${tsvTable(out, map[svc].headers)}`;
    return `${provider} ${svc}:\n${truncate(out, MAX_LIST_CHARS)}`;
  }

  // ── deploy (act): ONE whitelisted sync/upload of a contained dir ──────────
  const d = findDeployDir(root, args?.dir);
  if (!d.ok) return `ERROR: ${d.error}`;
  const pf = checkPrefix(args?.prefix);
  if (!pf.ok) return `ERROR: ${pf.error}`;
  const del = args?.delete === true || args?.delete === 'true';
  let argv, label;
  if (provider === 'aws') {
    const bucket = String(args?.bucket ?? '').trim();
    if (!BUCKET_RE.test(bucket) || bucket.includes('..')) {
      return `ERROR: bad bucket name "${truncate(String(args?.bucket ?? ''), 40)}" — buckets are lowercase [a-z0-9.-], 3–63 chars`;
    }
    argv = ['aws', 's3', 'sync', d.dir, `s3://${bucket}${pf.prefix ? '/' + pf.prefix : ''}`, ...(del ? ['--delete'] : [])];
    label = `s3 sync ${path.basename(d.dir)} → s3://${bucket}${pf.prefix ? '/' + pf.prefix : ''}${del ? ' (--delete)' : ''}`;
  } else if (provider === 'gcp') {
    const bucket = String(args?.bucket ?? '').trim();
    if (!BUCKET_RE.test(bucket) || bucket.includes('..')) {
      return `ERROR: bad bucket name "${truncate(String(args?.bucket ?? ''), 40)}" — buckets are lowercase [a-z0-9.-], 3–63 chars`;
    }
    argv = ['gcloud', 'storage', 'rsync', '--recursive', d.dir, `gs://${bucket}${pf.prefix ? '/' + pf.prefix : ''}`];
    label = `storage rsync ${path.basename(d.dir)} → gs://${bucket}${pf.prefix ? '/' + pf.prefix : ''}`;
  } else {
    const container = String(args?.container ?? '').trim();
    if (!CONTAINER_RE.test(container) || container.includes('--')) {
      return `ERROR: bad container name "${truncate(String(args?.container ?? ''), 40)}" — containers are lowercase [a-z0-9-], 3–63 chars, no consecutive dashes`;
    }
    argv = ['az', 'storage', 'blob', 'upload-batch', '--destination', container, '--source', d.dir];
    label = `blob upload-batch ${path.basename(d.dir)} → container ${container}`;
  }
  const r = runBin(argv, { root, timeoutMs: ACT_TIMEOUT_MS, runner });
  if (r.status !== 0) return honestExit(bin, r, `deploy (${label})`);
  return `deploy ok — ${label}\n${truncate(String(r.stdout || '').trim(), 3000)}`;
}

export function createCloudTool({ root } = {}) {
  return {
    name: 'cloud',
    description:
      'Inspect and deploy to cloud platforms through the MACHINE\'S OWN CLIs (aws, gcloud, az — probed on PATH at call time, never bundled; absent = honest refusal, an MCP server remains the other route). action:"status" shows which CLIs exist, who is authenticated (read-only identity calls), and which credential ENV VARS are set — NAMES only, values never printed (gate-free). action:"list" runs ONE whitelisted read-only inventory per provider (aws: s3/ec2/lambda · gcp: compute/storage/run · azure: vm/webapp/storage), capped output (gate-free). action:"deploy" is ONE whitelisted upload/sync (aws s3 sync · gcloud storage rsync · az blob upload-batch) of a directory INSIDE the project root — gated like every mutation. Only whitelisted flags are ever passed; nothing fake is ever reported.',
    args: '{"action":"status"} · {"action":"list","provider":"aws","service":"s3"} · {"action":"list","provider":"gcp","service":"compute","project":"my-proj"} · {"action":"deploy","provider":"aws","dir":"site/","bucket":"my-bucket","prefix":"www"} · {"action":"deploy","provider":"azure","dir":"site/","container":"mycontainer"}',
    riskyWhen: (a) => !READ_ACTIONS.has(String(a?.action || 'status').trim().toLowerCase()),
    render: (a) => `cloud ${String(a?.action || 'status')}${a?.provider ? ` ${String(a.provider)}` : ''}${a?.service ? ` ${String(a.service)}` : ''}${a?.dir ? ` ${truncate(String(a.dir), 30)}` : ''}${a?.bucket ? ` → ${truncate(String(a.bucket), 40)}` : a?.container ? ` → ${truncate(String(a.container), 40)}` : ''}`,
    run: async (args) => runCloud(args, { root }),
  };
}
