// settings.js — the shared .buddy/settings.json surface (v0.22.0).
//
// One file, many consumers: hooks (v0.11.0), permissions (v0.19.0), and now
// the UX/narration config (verbosity, theme, output style, statusline).
// updateProjectSetting merges — a UI tweak can never wipe a hooks block.
// User-level settings (~/.buddy/settings.json) still win the same way the
// rules engine merges: project writes go to the PROJECT file only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function settingsPath(root) {
  return path.join(root, '.buddy', 'settings.json');
}

/** Read .buddy/settings.json; junk degrades to {} with a warn. Never throws. */
export function readProjectSettings(root) {
  try {
    const raw = fs.readFileSync(settingsPath(root), 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Deep-merge a patch into the PROJECT settings file (preserves hooks/permissions). */
export function updateProjectSetting(root, patch) {
  const file = settingsPath(root);
  const current = readProjectSettings(root);
  const next = deepMerge(current, isPlainObject(patch) ? patch : {});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** Merged VIEW: user ~/.buddy/settings.json under project (project wins). */
export function loadSettingsView(root, { home = os.homedir() } = {}) {
  let user = {};
  try {
    const raw = fs.readFileSync(path.join(home, '.buddy', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) user = parsed;
  } catch {
    /* absent — normal */
  }
  return deepMerge(user, readProjectSettings(root));
}

/** Set one dot-path value in the project file: setChatSetting(root, 'verbosity', 'silent'). */
export function setChatSetting(root, key, value) {
  return updateProjectSetting(root, { chat: { [key]: value } });
}

/** Read one chat.* value from the merged view. */
export function getChatSetting(root, key, fallback = null, opts = {}) {
  const view = loadSettingsView(root, opts);
  const v = view?.chat?.[key];
  return v === undefined ? fallback : v;
}

/**
 * chat.toolCallCap — per-turn cap for tools that declare NO maxCalls of their
 * own. v0.64.1 default: REMOVED (Infinity) — the old `?? 6` strangled honest
 * research turns (the live-probe session burned 6 fs_reads and died mid-task).
 * A tool's DECLARED maxCalls (task's stampede guard, planmode's 3, gitwrite's
 * 8) always wins regardless of this knob. Rules mirror chat.workspaceWatch:
 *   absent / null / '' / false / 0 / 'off' / 'false' → Infinity (cap removed);
 *   positive integer (number or numeric string, ≤ 100000)            → that cap;
 *   everything else (true, 'abc', 7.5, -1, objects, 1e21)            → NAMED junk,
 *   the default (unlimited) holds — a junk value can never silently cap a turn.
 */
export function resolveToolCallCap(v) {
  if (v === undefined || v === null || v === '' || v === false) return { cap: Infinity, note: null };
  if (v === true) {
    return { cap: Infinity, note: 'chat.toolCallCap: true means nothing — a cap needs a NUMBER; the default (unlimited) holds' };
  }
  if (v === 0 || v === '0' || v === 'off' || v === 'false') return { cap: Infinity, note: null };
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  if (Number.isInteger(n) && n > 0 && n <= 100000) return { cap: n, note: null };
  let shown;
  try { shown = typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { shown = '[unprintable]'; }
  return { cap: Infinity, note: `chat.toolCallCap: junk value (${shown}) ignored — the default (unlimited) holds` };
}

/**
 * chat.maxSteps — the per-turn STEP budget override (v0.64.1). The effort
 * presets (low 12 / medium 30 / high 48) stay the default ladder; this knob
 * beats them when declared, so a long task (commit → test → docs → push →
 * CI → tag) stops dying at 14 steps with "I paused mid-task". Rules mirror
 * chat.toolCallCap, with one honest difference: ABSENT means the preset
 * ladder stands (a budget is the loop's forced wrap-up — removing it must
 * be a declaration, not a default):
 *   absent / null / ''                                    → null (preset stands);
 *   0 / '0' / 'off' / 'false' / false                      → Infinity (budget
 *     REMOVED — the turn ends when the model ends; the identical-repeat
 *     guard and the shell blocklist are then the only bounds. Declare it.)
 *   positive integer 2..1000 (number or numeric string)    → that budget;
 *   everything else (true, 'abc', 7.5, 1, -1, objects)     → NAMED junk, the
 *     preset holds — a typo can never silently shrink or grow the budget.
 */
export function resolveTurnBudget(v) {
  if (v === undefined || v === null || v === '') return { budget: null, note: null };
  if (v === false || v === 0 || v === '0' || v === 'off' || v === 'false') return { budget: Infinity, note: null };
  if (v === true) {
    return { budget: null, note: 'chat.maxSteps: true means nothing — a budget needs a NUMBER (0 removes it); the effort preset holds' };
  }
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  if (Number.isInteger(n) && n >= 2 && n <= 1000) return { budget: n, note: null };
  let shown;
  try { shown = typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { shown = '[unprintable]'; }
  return { budget: null, note: `chat.maxSteps: junk value (${shown}) ignored — the effort preset holds` };
}
