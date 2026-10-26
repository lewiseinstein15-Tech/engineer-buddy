// update.js — `buddy update` (v0.25.0): self-update from the latest git tag.
//
// Buddy ships as a git clone (zero deps, no npm install step), so updating =
// fetch tags → check out the newest release tag. Safety rails:
//   - a dirty working tree refuses (unless --force) — an update must never
//     mix itself into uncommitted user work
//   - --check reports without touching anything
//   - every git call is timeout-capped; a failed fetch is an honest error,
//     never a half-checked-out tree
// The pure parts (semver compare, tag picking, plan building) are exported
// for tests; cmdUpdate takes an injectable runner so tests drive the whole
// flow without a real repo.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CURRENT_VERSION = require('../package.json').version;

const GIT_TIMEOUT_MS = 60000;

/** git runner — injectable in tests. Contract: run(args, cwd) → { ok, stdout, stderr }. */
function git(args, cwd = process.cwd()) {
  const r = spawnSync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  return { ok: r.status === 0, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

/** Compare two "x.y.z" strings. True when a > b. Pure. */
export function semverGt(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** Parse "v1.2.3" → "1.2.3"; non-semver tags are rejected (null). Pure. */
export function tagVersion(tag) {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(String(tag || '').trim());
  return m ? m[1] : null;
}

/**
 * Pick the newest release tag strictly greater than the current version.
 * Unknown-format tags are ignored, not fatal. Pure.
 * @returns {string|null} the tag to check out, or null when up to date
 */
export function pickLatestTag(tags, currentVersion) {
  let best = null;
  let bestV = null;
  for (const tag of Array.isArray(tags) ? tags : []) {
    const v = tagVersion(tag);
    if (!v) continue;
    if (semverGt(v, currentVersion) && (!bestV || semverGt(v, bestV))) {
      best = tag;
      bestV = v;
    }
  }
  return best;
}

/**
 * Build the update plan (pure, testable): fetch → tag list → dirty check →
 * decision. `run` = (args, cwd) => { ok, stdout, stderr }.
 * @returns {{action: 'up-to-date'|'checkout'|'refuse'|'error', tag?, reason?, currentVersion}}
 */
export function planUpdate({ currentVersion, run, cwd, force = false }) {
  const fetchRes = run(['fetch', 'origin', '--tags'], cwd);
  if (!fetchRes.ok) return { action: 'error', reason: `git fetch failed: ${(fetchRes.stderr || '').trim().slice(0, 200)}`, currentVersion };
  const tagsOut = run(['tag', '-l', '--sort=-v:refname'], cwd);
  if (!tagsOut.ok) return { action: 'error', reason: `git tag failed: ${(tagsOut.stderr || '').trim().slice(0, 200)}`, currentVersion };
  const tag = pickLatestTag(tagsOut.stdout.split('\n'), currentVersion);
  if (!tag) return { action: 'up-to-date', currentVersion };
  const status = run(['status', '--porcelain'], cwd);
  if (status.ok && status.stdout.trim() && !force) {
    return { action: 'refuse', tag, reason: 'working tree has uncommitted changes — commit or stash first (or run with --force)', currentVersion };
  }
  return { action: 'checkout', tag, currentVersion, dirty: Boolean(status.ok && status.stdout.trim()) };
}

/**
 * @param {string[]} argv  args after `update`
 * @param {object} opts    { cwd } — injectable for tests
 */
export async function cmdUpdate(argv = [], { cwd = process.cwd(), out = console.log, run = git } = {}) {
  const flags = new Set(argv.map((a) => String(a).toLowerCase()));
  const checkOnly = flags.has('--check');
  const force = flags.has('--force');
  out(`buddy update — current v${CURRENT_VERSION}${checkOnly ? ' (check only)' : ''}`);
  const plan = planUpdate({ currentVersion: CURRENT_VERSION, run, cwd, force });
  if (plan.action === 'error') {
    out(`  ✗ ${plan.reason}`);
    return 1;
  }
  if (plan.action === 'up-to-date') {
    out(`  ✓ already on the latest release (v${plan.currentVersion})`);
    return 0;
  }
  if (plan.action === 'refuse') {
    out(`  ✗ update to ${plan.tag} refused: ${plan.reason}`);
    return 1;
  }
  // checkout — force flag relaxes ONLY the dirty-tree refusal (planUpdate
  // already refused without it); a failed checkout must be reported, not hidden.
  if (checkOnly) {
    out(`  ✓ newer release available: ${plan.tag} (run \`buddy update\` to apply)`);
    return 0;
  }
  if (plan.dirty) out('  ⚠ --force: updating on top of a dirty working tree');
  const co = run(['-c', 'advice.detachedHead=false', 'checkout', plan.tag], cwd);
  if (!co.ok) {
    out(`  ✗ checkout ${plan.tag} failed: ${(co.stderr || '').trim().slice(0, 200)}`);
    return 1;
  }
  out(`  ✓ updated: v${plan.currentVersion} → ${plan.tag}`);
  out(`  ${'·'} restart buddy to run the new version (npm test to verify)`);
  return 0;
}
