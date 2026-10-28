// containers.js — the container orchestration tool (v0.42.0, checklist §10):
// "docker compose up/down/logs tooling; local k8s (kind/minikube) status +
// deploy helpers via MCP."
//
// Zero-dep by construction: Buddy shells out to THE MACHINE'S OWN binaries
// (docker, kubectl, kind, minikube), probed on PATH at call time — nothing
// bundled, nothing faked. Absent binary → honest refusal naming what to
// install; a half-installed compose (docker without the compose plugin) is
// reported as exactly that, not guessed around.
//
// Read/act split mirrors the db tool:
//   status / logs — gate-free: docker ps + compose projects + kubectl
//                   context/pods, compose/docker logs with a capped tail.
//   up / down / restart / build (compose) and deploy (kubectl apply) —
//                   riskyWhen → approval gate. Only whitelisted flags are
//                   ever passed; the compose/manifest FILE must live inside
//                   the project root (containment, ../evil.yaml refused).
//   No exec, no volume mounts, no arbitrary kubectl args in v1 — the
//   compose file and the manifest govern everything else.
//
// Local k8s helpers: kind/minikube binaries are detected and reported with
// the current context; deploy goes through the repo's own kubectl apply.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { truncate } from '../util.js';

export const MAX_TAIL = 200;
export const DEFAULT_TAIL = 80;
export const MAX_PS_ROWS = 50;
export const READ_TIMEOUT_MS = 30000;
export const ACT_TIMEOUT_MS = 120000;
const READ_ACTIONS = new Set(['status', 'logs']);
const COMPOSE_ACTIONS = new Set(['up', 'down', 'restart', 'build']);
const KNOWN_ACTIONS = new Set(['status', 'logs', ...COMPOSE_ACTIONS, 'deploy']);
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const NS_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** Find the compose file: explicit arg (containment-enforced) or discovered
 *  in the project root. Refuses escapes and missing files honestly. */
export function findComposeFile(root, explicit = null) {
  if (explicit != null && String(explicit).trim()) {
    const p = String(explicit).trim();
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    if (!path.resolve(abs).startsWith(path.resolve(root) + path.sep) && path.resolve(abs) !== path.resolve(root)) {
      return { ok: false, error: `compose file escapes the project root: ${truncate(p, 80)}` };
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { ok: false, error: `compose file not found: ${truncate(p, 120)}` };
    }
    return { ok: true, file: path.resolve(abs) };
  }
  const found = COMPOSE_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  if (!found) {
    return { ok: false, error: `no compose file in the project root (looked for ${COMPOSE_FILES.join(', ')}) — pass {"file":"deploy/compose.yaml"} explicitly` };
  }
  return { ok: true, file: found };
}

/** docker ps TSV → pipe table, capped. Empty input renders honestly. */
export function renderDockerPs(tsv, { maxRows = MAX_PS_ROWS } = {}) {
  const rows = String(tsv || '').split('\n').map((l) => l.split('\t')).filter((c) => c.length >= 1 && c[0].trim());
  if (!rows.length) return '(no containers running)';
  const head = 'name | image | status | ports';
  const bar = '-'.repeat(46);
  const cell = (s) => truncate(String(s ?? '').trim() || '—', 60);
  let out = `${bar}\n${head}\n${bar}`;
  for (const c of rows.slice(0, maxRows)) out += `\n${[c[0], c[1], c[2], c[3] || ''].map(cell).join(' | ')}`;
  if (rows.length > maxRows) out += `\n… ${rows.length - maxRows} more containers`;
  return out;
}

/** Probe the machine's own binaries. Injectable for tests. */
export function probeContainers(root, probe = null) {
  if (probe) return probe(root);
  const check = (bin, args) => {
    try {
      const r = spawnSync(bin, args, { cwd: root, encoding: 'utf8', timeout: 8000 });
      return r.status === 0 ? truncate(String(r.stdout || r.stderr || '').trim().split('\n')[0], 60) : null;
    } catch { return null; }
  };
  const docker = check('docker', ['--version']);
  return {
    docker,
    compose: docker ? check('docker', ['compose', 'version']) : null,
    kubectl: check('kubectl', ['version', '--client=true', '-o', 'yaml']) ? 'kubectl' : null,
    kind: check('kind', ['version']),
    minikube: check('minikube', ['version']),
  };
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

function podTable(tsv, { maxRows = 30 } = {}) {
  const rows = String(tsv || '').split('\n').map((l) => l.split('\t')).filter((c) => c.length >= 3 && c[0].trim());
  if (!rows.length) return '(no pods)';
  const bar = '-'.repeat(40);
  let out = `${bar}\nnamespace | pod | ready | status\n${bar}`;
  const cell = (s) => truncate(String(s ?? '').trim(), 44);
  for (const c of rows.slice(0, maxRows)) out += `\n${[c[0], c[1], c[2], c[3] || ''].map(cell).join(' | ')}`;
  if (rows.length > maxRows) out += `\n… ${rows.length - maxRows} more pods`;
  return out;
}

/** One containers tool call → observation string (never throws). */
export function runContainers(args = {}, { root = process.cwd(), probe = null, runner = null } = {}) {
  const action = String(args?.action || 'status').trim().toLowerCase();
  if (!KNOWN_ACTIONS.has(action)) {
    return `ERROR: unknown action "${truncate(String(args?.action || ''), 24)}" — known: status, logs, up, down, restart, build, deploy`;
  }
  const bins = probeContainers(root, probe);
  const services = (Array.isArray(args?.services) ? args.services : args?.services ? [args.services] : []).map((s) => String(s).trim());
  for (const s of services) {
    if (!NAME_RE.test(s)) return `ERROR: bad service name "${truncate(s, 40)}" — names are [A-Za-z0-9._-] only (no shell metacharacters, ever)`;
  }

  // ── status (read): what is actually running on this machine ──────────────
  if (action === 'status') {
    const lines = ['containers status'];
    if (!bins.docker) {
      lines.push('docker: not on PATH — install Docker (compose ships as the "docker compose" plugin) and retry; nothing fake is reported');
    } else {
      lines.push(`docker: ${bins.docker}${bins.compose ? ` · compose: ${truncate(bins.compose, 40)}` : ' · compose plugin: NOT installed (docker compose version failed)'}`);
      const ps = runBin(['docker', 'ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'], { root, timeoutMs: READ_TIMEOUT_MS, runner });
      lines.push(ps.status === 0 ? renderDockerPs(ps.stdout) : `docker ps failed — exit ${ps.status}${ps.stderr ? `\n${truncate(String(ps.stderr), 300)}` : ''}`);
      if (bins.compose) {
        const ls = runBin(['docker', 'compose', 'ls', '--format', '{{.Name}}\t{{.Status}}\t{{.ConfigFiles}}'], { root, timeoutMs: READ_TIMEOUT_MS, runner });
        if (ls.status === 0 && String(ls.stdout).trim()) {
          const rows = String(ls.stdout).trim().split('\n').slice(0, 10).map((l) => l.split('\t').map((c) => truncate(c.trim(), 50)).join(' | '));
          lines.push(`compose projects:\n${rows.join('\n')}`);
        }
      }
    }
    const k8s = [];
    if (bins.kubectl) {
      const ctx = runBin(['kubectl', 'config', 'current-context'], { root, timeoutMs: READ_TIMEOUT_MS, runner });
      if (ctx.status === 0) {
        k8s.push(`kubectl: present · context: ${truncate(String(ctx.stdout).trim(), 40)}`);
        const pods = runBin(['kubectl', 'get', 'pods', '-A', '--no-headers', '-o', 'custom-columns=ns:.metadata.namespace,name:.metadata.name,ready:.status.containerStatuses[0].ready,phase:.status.phase'], { root, timeoutMs: READ_TIMEOUT_MS, runner });
        if (pods.status === 0) k8s.push(podTable(pods.stdout));
        else k8s.push(`kubectl get pods failed — exit ${pods.status}${pods.stderr ? `\n${truncate(String(pods.stderr), 300)}` : ''}`);
      } else {
        k8s.push('kubectl: present, but no usable cluster context (config current-context failed)');
      }
    } else {
      k8s.push('kubectl: not on PATH — local k8s status needs it (kind/minikube provide one)');
    }
    k8s.push(`kind: ${bins.kind ? truncate(bins.kind, 50) : 'not found'} · minikube: ${bins.minikube ? truncate(bins.minikube, 50) : 'not found'}`);
    return `${lines.join('\n')}\n${k8s.join('\n')}`;
  }

  // ── logs (read): capped tail, compose project or plain container ─────────
  if (action === 'logs') {
    if (!bins.docker) return 'ERROR: docker is not on PATH — install Docker and retry';
    const tailRaw = args?.tail;
    const tail = tailRaw == null ? DEFAULT_TAIL : Math.floor(Number(tailRaw));
    if (!Number.isFinite(tail) || tail < 1) {
      return `ERROR: tail must be a number of lines (1–${MAX_TAIL}) — got "${truncate(String(tailRaw), 24)}"`;
    }
    const tailN = Math.min(MAX_TAIL, tail);
    if (args?.file != null || findComposeFile(root, null).ok) {
      const f = findComposeFile(root, args?.file ?? null);
      if (!f.ok) return `ERROR: ${f.error}`;
      const srv = services.slice(0, 5);
      const argv = ['docker', 'compose', '-f', f.file, 'logs', '--tail', String(tailN), '--no-color', ...srv];
      const r = runBin(argv, { root, timeoutMs: READ_TIMEOUT_MS, runner });
      if (r.status !== 0) return honestExit('docker compose', r, `logs (${path.basename(f.file)})`);
      const body = String(r.stdout || '').split('\n').slice(-tailN).join('\n');
      const label = `compose logs — ${path.basename(f.file)}${srv.length ? ` (${srv.join(', ')})` : ''} (last ${tailN} lines)`;
      return `${label}\n${truncate(body.trim() || '(no output)', 6000)}`;
    }
    const name = services[0];
    if (!name) return 'ERROR: logs need a service (with a compose file) or {"services":["container-name"]} for plain docker logs';
    const r = runBin(['docker', 'logs', '--tail', String(tailN), name], { root, timeoutMs: READ_TIMEOUT_MS, runner });
    if (r.status !== 0 && !String(r.stdout).trim()) return honestExit('docker logs', r, `logs (${name})`);
    const body = String(r.stdout || String(r.stderr || '')).split('\n').slice(-tailN).join('\n');
    return `docker logs — ${name} (last ${tailN} lines)\n${truncate(body.trim() || '(no output)', 6000)}`;
  }

  // ── deploy (act): kubectl apply -f <file inside the project> ─────────────
  if (action === 'deploy') {
    if (!bins.kubectl) return 'ERROR: kubectl is not on PATH — install kubectl (or a local cluster: kind / minikube) and retry';
    const p = String(args?.file || '').trim();
    if (!p) return 'ERROR: deploy needs {"file":"k8s/deployment.yaml"} — a manifest inside the project root';
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    if (!path.resolve(abs).startsWith(path.resolve(root) + path.sep) && path.resolve(abs) !== path.resolve(root)) {
      return `ERROR: manifest escapes the project root: ${truncate(p, 80)}`;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `ERROR: manifest not found: ${truncate(p, 120)}`;
    const ns = args?.namespace != null ? String(args.namespace).trim() : null;
    if (ns && !NS_RE.test(ns)) return `ERROR: bad namespace "${truncate(ns, 40)}"`;
    const argv = ['kubectl', 'apply', '-f', path.resolve(abs), ...(ns ? ['-n', ns] : [])];
    const r = runBin(argv, { root, timeoutMs: ACT_TIMEOUT_MS, runner });
    if (r.status !== 0) return honestExit('kubectl apply', r, `deploy (${path.basename(String(p))})`);
    return `deploy ok — ${path.basename(String(p))} applied${ns ? ` to namespace ${ns}` : ''}\n${truncate(String(r.stdout || '').trim(), 3000)}`;
  }

  // ── compose lifecycle (act): up / down / restart / build ────────────────
  if (!bins.docker) return 'ERROR: docker is not on PATH — install Docker and retry';
  if (!bins.compose) return 'ERROR: the docker compose plugin is not installed (docker compose version failed) — install the compose plugin and retry';
  const f = findComposeFile(root, args?.file ?? null);
  if (!f.ok) return `ERROR: ${f.error}`;
  const rel = path.relative(root, f.file);
  const argvBase = ['docker', 'compose', '-f', f.file];
  let argv, label;
  if (action === 'up') {
    argv = [...argvBase, 'up', '-d', ...(args?.build === true || args?.build === 'true' ? ['--build'] : []), ...services];
    label = `up (detached)${services.length ? ` — ${services.join(', ')}` : ''}`;
  } else if (action === 'down') {
    argv = [...argvBase, 'down', ...(args?.volumes === true || args?.volumes === 'true' ? ['-v'] : []), ...services];
    label = `down${args?.volumes ? ' (with volumes)' : ''}`;
  } else if (action === 'restart') {
    argv = [...argvBase, 'restart', ...services];
    label = `restart${services.length ? ` — ${services.join(', ')}` : ''}`;
  } else {
    argv = [...argvBase, 'build', ...services];
    label = 'build';
  }
  const r = runBin(argv, { root, timeoutMs: ACT_TIMEOUT_MS, runner });
  if (r.status !== 0) return honestExit('docker compose', r, `${label} (${rel})`);
  return `compose ${label} — ok (${rel})\n${truncate(String(r.stdout || '').trim(), 3000)}`;
}

export function createContainersTool({ root } = {}) {
  return {
    name: 'containers',
    description:
      'Inspect and drive Docker Compose + local Kubernetes through the MACHINE\'S OWN binaries (docker, kubectl, kind, minikube — probed on PATH at call time, never bundled; absent = honest refusal). action:"status" shows running containers, compose projects, kubectl context + pods (gate-free); action:"logs" tails compose or container logs (capped); up/down/restart/build run compose against the project\'s compose file ({"file":…} or auto-discovered in the root) and ask for approval; action:"deploy" is kubectl apply of a manifest INSIDE the project root (gated). Only whitelisted flags are ever passed — no exec, no volume mounts, no arbitrary kubectl arguments.',
    args: '{"action":"status"} · {"action":"logs","services":["web"],"tail":80} · {"action":"up","file":"compose.yaml","build":true,"services":["web"]} · {"action":"down"} · {"action":"deploy","file":"k8s/app.yaml","namespace":"default"}',
    riskyWhen: (a) => !READ_ACTIONS.has(String(a?.action || 'status').trim().toLowerCase()),
    render: (a) => `containers ${String(a?.action || 'status')}${a?.file ? ` ${truncate(String(a.file), 40)}` : ''}${a?.services ? ` (${[].concat(a.services).join(',')})` : ''}`,
    run: async (args) => runContainers(args, { root }),
  };
}
