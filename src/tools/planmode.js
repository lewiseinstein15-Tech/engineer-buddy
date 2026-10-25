// planmode.js — Plan mode: Buddy researches read-only until you approve the plan.
//
// Claude Code parity: plan mode turns the agent into an architect. It can
// search, read, and think — but never edit, run commands, spawn sub-agents,
// or call MCP tools. When research is done, the model calls `exit_plan` with
// the full plan; that tool is approval-gated, so the [y/n/a] gate IS the
// plan approval. On "yes", plan mode switches off in-place and the SAME turn
// continues straight into implementation — no restart, no lost context.
//
// Policy layering (same discipline as every Buddy tool):
//   allowlist  — PLAN_TOOLS is the only door; everything else is refused
//                BEFORE call caps burn and BEFORE the approval gate fires
//   gate       — exit_plan is risky → the plan text renders as the preview
//   persistence— approved plans are saved under .buddy/plans/ for /plans
import fs from 'node:fs';
import path from 'node:path';
import { truncate } from '../util.js';

/** Tools the model may use while plan mode is ON. Everything else is blocked. */
export const PLAN_TOOLS = new Set([
  'todo', // plan drafting
  'fs_list', // research
  'fs_read',
  'fs_search',
  'web_search', // docs lookup (read-only, safe-flagged)
  'web_fetch',
  'skill', // loading a playbook is read-only; its allowed-tools still bind
  'exit_plan',
]);

export const PLANS_DIR = '.buddy/plans';

/** The system-prompt section injected while plan mode is active. */
export function planModePrompt() {
  return [
    '## Plan mode (READ-ONLY)',
    'Plan mode is ON. You may ONLY use these tools: fs_search, fs_read, fs_list, web_search, web_fetch, todo, skill, exit_plan.',
    'Everything else (fs_write, fs_replace, fs_append, bash, task, MCP tools, background shells) is blocked until the user approves your plan.',
    'Workflow: research the code until you understand it, then call exit_plan with the complete implementation plan as markdown (steps, files to touch, risks).',
    'Never claim a change is made — nothing has been edited.',
  ].join('\n');
}

/** "Add a /plan Mode!" → "add-a-plan-mode" (safe for filenames). */
export function slugify(text, maxLen = 40) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
  return s || 'plan';
}

/** Save an approved plan. Returns the absolute path written. */
export function savePlan(root, { task = '', plan = '' } = {}) {
  const dir = path.join(root, PLANS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${stamp}-${slugify(task)}.md`);
  const body = [
    `# Plan — ${truncate(String(task || '(untitled task)'), 100)}`,
    '',
    `- saved: ${new Date().toISOString()}`,
    '',
    String(plan || '').trimEnd(),
    '',
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/** List saved plans, newest first. [{ file, mtime }] — never throws. */
export function listPlans(root) {
  try {
    const dir = path.join(root, PLANS_DIR);
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const file = path.join(dir, f);
        let mtime = '';
        try {
          mtime = fs.statSync(file).mtime.toISOString();
        } catch {
          /* raced deletion */
        }
        return { file, mtime };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  } catch {
    return [];
  }
}

/**
 * The `exit_plan` tool. Registered only in interactive sessions (modes given).
 * Approval flow rides the standard risky-tool gate: `preview` renders the
 * plan text above the [y/n/a] question, so the user reads the whole plan
 * before deciding. Denial keeps plan mode ON — the model refines and retries.
 */
export function buildExitPlanTool({ modes, root, onApproved = () => {} } = {}) {
  return {
    name: 'exit_plan',
    description:
      'Present your implementation plan and exit plan mode. Call it when research is done. The user approves or rejects; only on approval may you edit files.',
    args: '{"summary":"one line","plan":"## Plan\\n1. step\\n2. step"}',
    risky: true,
    maxCalls: 3, // a denial lets the model refine — but not forever
    render: (a) => `exit_plan ${truncate(String(a?.summary || a?.plan || ''), 64)}`,
    preview: (a) => {
      const lines = String(a?.plan || '(no plan text)').split('\n');
      const body = lines.slice(0, 40).join('\n');
      return `${body}${lines.length > 40 ? `\n… (${lines.length - 40} more lines)` : ''}`;
    },
    run: async (args = {}) => {
      const plan = typeof args.plan === 'string' && args.plan.trim() ? args.plan.trim() : null;
      if (!plan) return 'ERROR: plan required — pass the full markdown plan as "plan" (and a one-line "summary").';
      if (!modes || !modes.plan) return 'ERROR: plan mode is not active — nothing to exit. Just say your message.';
      const summary = truncate(String(args.summary || ''), 80);
      const saved = savePlan(root, { task: summary || plan.split('\n')[0], plan });
      modes.plan = false;
      try {
        onApproved({ saved, summary, plan });
      } catch {
        /* TUI is best effort — the flip already happened */
      }
      return `PLAN APPROVED — plan mode is now OFF. Plan saved: ${path.relative(root, saved)}\nYou may now edit files and run commands. Follow the approved plan step by step.`;
    },
  };
}
