// secret.js — the secrets vault integration (v0.41.0, checklist §10).
//
// "Read secrets from 1Password CLI / `pass` / env refs at run time; never
// logged, never in transcripts."
//
// The contract Buddy makes with the user:
//   1. Secrets are REFERENCED, never written: `env:NAME`, `pass:entry/path`,
//      `op://vault/item/field` — the reference is all that ever appears in
//      args, transcripts, the audit trail, or the model's context.
//   2. Resolution happens AT CALL TIME in the tool process: `pass show`,
//      `op read`, or an env lookup. The resolved value flows straight into
//      the consumer (e.g. an http Authorization header) and is dropped.
//   3. No tool surface ever returns the value. `secret check` reports
//      backend + length only; errors quote the ref, never the secret.
//
// Consumers: the http tool's auth accepts {"type":"bearer","ref":"pass:..."}
// (see http.js) — vault secrets work everywhere env refs did.

import { spawnSync } from 'node:child_process';

const CLI_TIMEOUT_MS = 10000;

/** Parse a secret reference. Returns {backend, ref} or {error}.
 *  env:NAME | pass:entry/path | op://vault/item/field */
export function parseSecretRef(ref) {
  const r = String(ref || '').trim();
  if (!r) return { error: 'secret ref required — e.g. "env:GITHUB_TOKEN", "pass:github/token", "op://Vault/Item/field"' };
  if (r.startsWith('env:')) {
    const name = r.slice(4).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { error: `env ref must name an environment variable (got "${truncateRef(r)}")` };
    return { backend: 'env', ref: name };
  }
  if (r.startsWith('pass:')) {
    const entry = r.slice(5).trim();
    if (!entry || /\s/.test(entry)) return { error: `pass ref must be an entry path without spaces (got "${truncateRef(r)}")` };
    return { backend: 'pass', ref: entry };
  }
  if (r.startsWith('op://')) {
    const rest = r.slice(5);
    if (rest.split('/').filter(Boolean).length < 3) return { error: '1Password refs look like op://Vault/Item/field' };
    return { backend: 'op', ref: r };
  }
  return { error: `unknown secret ref "${truncateRef(r)}" — use env:NAME, pass:entry/path, or op://Vault/Item/field` };
}

const truncateRef = (r) => String(r).slice(0, 40);

/** One CLI probe, injectable for offline tests. */
export function runVaultCli(cmd, argv, { runner = null, input = null } = {}) {
  const fn = runner || ((c, a) => spawnSync(c, a, { timeout: CLI_TIMEOUT_MS, encoding: 'utf8' }));
  return fn(cmd, argv, input);
}

/** Resolve a secret ref to its VALUE. The value is for the caller's immediate
 *  use only — it must never be logged, echoed, or returned to the model.
 *  Returns {value} or {error} (errors never contain the value). */
export async function resolveSecretRef(ref, { env = process.env, runner = null } = {}) {
  const parsed = parseSecretRef(ref);
  if (parsed.error) return parsed;
  const { backend, ref: target } = parsed;
  if (backend === 'env') {
    const value = env?.[target];
    if (typeof value !== 'string' || !value) return { error: `environment variable ${target} is not set — export it, then retry (the secret itself never appears in this conversation)` };
    return { value };
  }
  if (backend === 'pass') {
    const r = runVaultCli('pass', ['show', target], { runner });
    if (r.error === true || r.error instanceof Error || (r.error && typeof r.error === 'object')) {
      return { error: `the pass CLI is not available (is it installed and on PATH?) — or use env refs (ref was ${truncateRef(ref)})` };
    }
    if (r.status !== 0) return { error: `pass exited ${r.status} for "${truncateRef(ref)}" — wrong key, missing entry, or no agent; output suppressed (ref was ${truncateRef(ref)})` };
    const out = String(r.stdout || '');
    if (!out.trim()) return { error: `pass entry "${truncateRef(ref)}" is empty` };
    return { value: out.split('\n')[0].trimEnd() }; // pass convention: the password is line 1
  }
  // op:// — 1Password CLI
  const r = runVaultCli('op', ['read', target], { runner });
  if (r.error === true || r.error instanceof Error || (r.error && typeof r.error === 'object')) {
    return { error: 'the op (1Password) CLI is not available (is it installed, signed in?) — or use env refs' };
  }
  if (r.status !== 0) return { error: `op exited ${r.status} for the requested ref — not signed in, locked vault, or missing item; output suppressed` };
  const out = String(r.stdout || '');
  if (!out.trim()) return { error: 'the 1Password field resolved to an empty value' };
  return { value: out.replace(/\n+$/, '') };
}

/** Existence probe WITHOUT the value: {ok, backend, length} | {error}. */
export async function checkSecretRef(ref, opts = {}) {
  const r = await resolveSecretRef(ref, opts);
  if (r.error) return { error: r.error };
  const parsed = parseSecretRef(ref);
  return { ok: true, backend: parsed.backend, length: r.value.length };
}

/** Which backends could work right now? Binary presence only — no lookups. */
export function describeBackends({ runner = null, env = process.env } = {}) {
  const probe = (bin, argv) => {
    const r = runVaultCli(bin, argv, { runner });
    return !r.error && r.status === 0;
  };
  const envCount = Object.keys(env || {}).filter((k) => /TOKEN|SECRET|KEY|PASS|PASSWORD|CREDENTIAL|PAT\b/i.test(k)).length;
  return {
    env: true,
    envHint: `${envCount} env var${envCount === 1 ? '' : 's'} look like credentials (TOKEN/SECRET/KEY/… pattern)`,
    pass: probe('pass', ['--version']) ? 'pass CLI on PATH' : 'pass CLI not found',
    op: probe('op', ['--version']) ? '1Password CLI on PATH' : 'op CLI not found',
  };
}

export function createSecretTool({ env = process.env, runner = null } = {}) {
  return {
    name: 'secret',
    description:
      'Work with secrets WITHOUT ever pulling their values into the conversation. action:"check" resolves a reference (env:NAME, pass:entry/path, op://Vault/Item/field) and reports backend + length only — never the value; action:"backends" shows which vaults are usable right now. Use env:/pass:/op:// refs in other tools\' auth (http accepts {"type":"bearer","ref":"pass:…"}) so the secret is resolved at call time and lands only in the outgoing request. Mind echo endpoints: a server that prints your auth back in the response body puts that echo in the transcript — pick quiet endpoints for vault-backed calls.',
    args: '{"action":"check","ref":"pass:github/token"} | {"action":"backends"}',
    render: (a) => `secret ${a?.action || 'check'} ${a?.ref || ''}`.trim(),
    run: async (args = {}) => {
      const action = String(args?.action || 'check');
      if (action === 'backends') {
        const b = describeBackends({ env, runner });
        return [
          `secret backends — env refs: always · pass: ${b.pass.includes('on PATH') ? 'on PATH' : 'not found'} · 1Password: ${b.op.includes('on PATH') ? 'on PATH' : 'not found'}`,
          'refs never carry values: env:NAME · pass:entry/path · op://Vault/Item/field',
        ].join('\n');
      }
      if (action !== 'check') return `ERROR: action must be "check" or "backends" (got "${String(action).slice(0, 24)}")`;
      const r = await checkSecretRef(args?.ref, { env, runner });
      if (r.error) return `ERROR: ${r.error}`;
      return `secret ref "${String(args.ref).slice(0, 80)}" resolves — backend ${r.backend}, ${r.length} char${r.length === 1 ? '' : 's'}. The value never enters this conversation; it is resolved at call time wherever the ref is used (e.g. http auth).`;
    },
  };
}
