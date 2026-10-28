// sandbox.js — §9 sandbox mode: bash runs with the network OFF and a
// restricted HOME.
//
// Threat model (honest scope): the bash tool is the only path that spawns
// arbitrary shell commands from model args. When sandbox mode is ON, every
// model-driven bash call runs inside a Linux user+network namespace
// (`unshare -rn`): the namespace has no interfaces beyond a DOWN loopback,
// so DNS, sockets, and fetch all fail instantly (EAI_AGAIN / ENETDOWN-level
// errors) — not after a timeout — and $HOME points at an empty per-project
// sandbox dir, so ~/.ssh, ~/.aws, ~/.netrc and friends are simply not there.
// Files created inside the namespace are owned by the real user outside
// (root-inside maps back), so builds and tests still write normally.
//
// What sandbox does NOT cover (said out loud, not buried): the approval-gated
// tools (fs_write, git_write, http, web_*) have their own gates and policy
// paths; the user's own `!` shell passthrough is deliberately NEVER sandboxed
// (the human typed it); other operating systems get a degraded, clearly
// labelled mode (restricted HOME only) because unshare is Linux-only.
// For a hard boundary the docs ship a docker/podman profile — containers are
// the strong option; this namespace sandbox is the zero-dep everyday one.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const UNSHARE_PREFIX = 'unshare -rn';

/** Shell prefix that turns the network off. Linux-only; null elsewhere. */
export function sandboxPrefix(platform = process.platform) {
  return platform === 'linux' ? UNSHARE_PREFIX : null;
}

/**
 * Environment for a sandboxed run: HOME swapped to an empty sandbox dir so
 * dotfile secrets (~/.ssh, ~/.aws, ~/.netrc, ~/.gitcredentials) are absent.
 * Everything else the base spawn env already carries is preserved.
 * @returns {{HOME: string, SANDBOX: string}} overrides merged over the base env
 */
export function sandboxEnvOverrides(sandboxHome) {
  return { HOME: sandboxHome, SANDBOX: '1' };
}

/**
 * Probe whether THIS machine can actually run the namespace sandbox:
 * `unshare -rn true` must exit 0. Unprivileged user namespaces are a kernel
 * setting on some distros — probing beats assuming. The runner is injectable
 * for tests.
 * @param {{run?: (cmd: string) => {status: number|null, error?: object}}} opts
 * @returns {{ok: boolean, kind: 'unshare'|'none', detail: string}}
 */
export function detectSandboxCapability({ run, platform = process.platform } = {}) {
  if (platform !== 'linux') {
    return { ok: false, kind: 'none', detail: `namespace sandbox is Linux-only (this is ${platform}) — restricted HOME still applies` };
  }
  const runner = run || ((cmd) => {
    try {
      return spawnSync(cmd, { shell: true, timeout: 5000 });
    } catch (e) {
      return { status: null, error: e };
    }
  });
  let r;
  try {
    r = runner(`${UNSHARE_PREFIX} true`);
  } catch (e) {
    return { ok: false, kind: 'none', detail: `probe failed: ${e.message}` };
  }
  if (r && r.status === 0) return { ok: true, kind: 'unshare', detail: 'unshare -rn verified on this machine' };
  const why = r && r.error ? r.error.message : r && r.status != null ? `exit ${r.status}` : 'no result';
  return { ok: false, kind: 'none', detail: `unshare -rn unusable here (${why}) — user namespaces may be disabled; restricted HOME still applies` };
}

/** Create (once) and return the sandbox HOME for a project root. */
export function ensureSandboxHome(root) {
  const home = path.join(root, '.buddy', 'sandbox', 'home');
  mkdirSync(home, { recursive: true });
  return home;
}

/**
 * The live sandbox context: one object, created at REPL startup (state read
 * from settings), threaded into buildLocalTools, mutated by /sandbox.
 * The bash tool reads `enabled` on every call — no rebuild needed.
 */
export function makeSandboxContext(root, { platform = process.platform, probe } = {}) {
  const cap = detectSandboxCapability({ platform, ...(probe ? { run: probe } : {}) });
  const home = ensureSandboxHome(root);
  const prefix = sandboxPrefix(platform);
  const ctx = {
    enabled: false, // settings decide; the REPL flips this at startup
    platform,
    home,
    capability: cap,
    /** Full spawn-time overrides for runBash, or null when sandbox cannot bind. */
    spawnOverrides() {
      if (!this.enabled) return null;
      return { env: sandboxEnvOverrides(this.home), prefix: cap.ok ? prefix : null };
    },
  };
  return ctx;
}

/** /sandbox argument grammar: nothing | on | off | profile. */
export function parseSandboxArgs(args) {
  const a = String(args || '').trim().toLowerCase();
  if (!a) return { action: 'status' };
  if (a === 'on' || a === 'off' || a === 'profile') return { action: a };
  return { action: 'status', error: `unknown argument "${a}" — /sandbox · /sandbox on · /sandbox off · /sandbox profile` };
}

/** Status block for /sandbox and /status. */
export function renderSandboxStatus(ctx, { colored = (s) => s } = {}) {
  const lines = [];
  if (ctx.enabled) {
    const net = ctx.capability.ok ? 'off (netns: unshare -rn)' : 'UNAVAILABLE — network NOT isolated';
    lines.push(`  sandbox: ${colored('ON')} — bash network ${net}`);
    lines.push(`  HOME: ${ctx.home} (empty sandbox dir, secrets absent)`);
    if (!ctx.capability.ok) lines.push(`  ${ctx.capability.detail}`);
  } else {
    lines.push('  sandbox: off — bash runs with the usual blocklist + gates only (/sandbox on)');
  }
  return lines.join('\n');
}

/**
 * The strong option, documented in text: an actual container boundary.
 * Print via `/sandbox profile` — never auto-launched (zero-dep, keyless core
 * stays out of docker orchestration).
 */
export function dockerProfile({ root = '.', image = 'node:22-bookworm-slim' } = {}) {
  return [
    '  Strong option — run Buddy inside a container (hard boundary, not just namespaces):',
    '',
    '  docker:',
    `    docker run --rm -it --network none \\`,
    `      -v ${root}:/work -w /work \\`,
    `      -e HOME=/tmp/sandbox-home \\`,
    `      ${image} \\`,
    `      node src/index.js`,
    '',
    '  podman (rootless by default):',
    `    podman run --rm -it --network none \\`,
    `      -v ${root}:/work -w /work \\`,
    `      -e HOME=/tmp/sandbox-home \\`,
    `      ${image} \\`,
    `      node src/index.js`,
    '',
    '  Notes:',
    '    --network none = no interfaces at all (stronger than the netns sandbox, which keeps a DOWN loopback).',
    '    Mount ONLY the project (-v <root>:/work) — the host HOME never enters the container.',
    '    Brain gateways need network; run the container profile with ollama (offline fallback) or fetch tasks in a second, non-sandboxed session.',
    '    git_write push and web tools intentionally fail under --network none — that is the point of the boundary.',
  ].join('\n');
}
