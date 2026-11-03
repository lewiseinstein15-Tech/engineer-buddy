// runtoken.js — single-use unattended permission grants (v0.68.0, wave 4).
//
// The v0.67 rule stands: a headless run DENIES risky tools. Wave 4 adds the
// one legitimate widening — the operator's own per-goal allowlist, delivered
// to the goal child as a RUN TOKEN:
//
//   - the goals spawner writes .buddy/serve/runs/<random>.json
//     {token, goalId, allow: ["Tool(spec)", …]} and passes the file path +
//     token to the child in the environment;
//   - the child validates BOTH (path must resolve under serve/runs/, token
//     must match constant-time), loads the allow rules for THIS run only,
//     then consumes the file — single-use, so a replayed or inherited token
//     is worthless;
//   - the agent inside the child can neither read serve/** (wave 0 firewall
//     on the fs tools) nor run bash (headless default-deny), so it cannot
//     mint, move, or read a token; and the env vars are deleted the moment
//     the token is consumed, so a nested spawn inherits nothing.
//
// Settings-level deny rules still beat the allowlist: the gate evaluates
// denies BEFORE the approval layer ever runs (chat.js verdict order), so an
// allow rule cannot resurrect a denied tool.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { runsDir } from './paths.js';

export const MAX_ALLOW_RULES = 20;
export const MAX_RULE_LEN = 200;
const RULE_RE = /^[A-Za-z_][\w$]*(\((?:[^()\\]|\\.)*\))?$/; // the Tool(spec) shape, no nesting

const safeEq = (a, b) => {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

/** Mint a run token for one goal fire. Returns {file, token, goalId} — the
 *  caller puts file+token in the child's env and nothing else ever sees it. */
export function writeRunFile(root, { goalId, allow }) {
  const rules = (Array.isArray(allow) ? allow : []).map(String).filter((r) => RULE_RE.test(r) && r.length <= MAX_RULE_LEN).slice(0, MAX_ALLOW_RULES);
  if (!rules.length) throw new Error('writeRunFile: an empty allowlist is not a token — goals with no allow rules just run default-deny');
  const dir = runsDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString('hex');
  const name = `run-${randomBytes(16).toString('hex')}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ token, goalId: String(goalId ?? ''), allow: rules, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return { file, token, goalId: String(goalId ?? ''), rules: rules.length };
}

/** Consume the run token from the environment (if any). Returns
 *  {ok:true, goalId, allow:[…]} | {ok:false, reason} | null (no token — the
 *  normal default-deny run). ALWAYS consumes: deletes the file and scrubs
 *  the env vars whether validation passes or fails — a token is single-use
 *  even when it is a hostile one. */
export function loadRunToken(root, env = process.env) {
  const file = env.BUDDY_RUN_FILE;
  const token = env.BUDDY_RUN_TOKEN;
  delete env.BUDDY_RUN_FILE;
  delete env.BUDDY_RUN_TOKEN;
  if (!file && !token) return null;
  const consume = () => { try { fs.unlinkSync(file); } catch { /* gone is fine */ } };
  try {
    if (!file || !token) return fail('run token incomplete (file or token half missing)');
    const runsReal = (() => { try { return fs.realpathSync(runsDir(root)); } catch { return null; } })();
    const fileReal = (() => { try { return fs.realpathSync(file); } catch { return null; } })();
    if (!runsReal || !fileReal || fileReal !== path.join(runsReal, path.basename(fileReal))) {
      return fail('run token file does not live under .buddy/serve/runs/ — refused');
    }
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(fileReal, 'utf8'));
    } catch {
      return fail('run token file unreadable or torn');
    }
    consume(); // single-use from the moment it is read — pass or fail
    if (!doc || typeof doc !== 'object' || !safeEq(doc.token, token)) {
      return fail('run token mismatch');
    }
    const rules = (Array.isArray(doc.allow) ? doc.allow : [])
      .map(String)
      .filter((r) => RULE_RE.test(r) && r.length <= MAX_RULE_LEN)
      .slice(0, MAX_ALLOW_RULES);
    if (!rules.length) return fail('run token carries no valid allow rules');
    return { ok: true, goalId: String(doc.goalId ?? ''), allow: rules };
  } catch (e) {
    consume();
    return fail(`run token validation failed — ${String(e?.message || e)}`);
  }

  function fail(reason) {
    consume();
    return { ok: false, reason };
  }
}
