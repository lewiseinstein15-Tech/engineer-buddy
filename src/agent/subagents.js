// subagents.js — Buddy's crew: specialized sub-agents the main loop can
// dispatch through the `task` tool (Claude Code's Task tool, Buddy edition).
//
// Design (zero dependencies, zero recursion):
//   - A sub-agent is a persona + a tool allowlist + a step budget.
//   - It runs on the SAME bounded ReAct loop as one-shot skills
//     (agent/agent.js runAgent): strict-JSON protocol, self-repair retry.
//   - Depth limit is structural: the sub-agent's tool list never contains
//     `task`, so a sub-agent can never spawn another sub-agent.
//   - Failure isolation: a sub-agent crash is returned as an observation
//     string ("ERROR: …"), never thrown into the main conversation.
//
// Agent definitions (Claude Code's .claude/agents/*.md equivalent):
//   .buddy/agents/<name>.md
//     ---
//     name: scout                    (optional — defaults to filename)
//     description: what it is for    (shown to the main agent)
//     tools: fs_read, fs_search      (comma-separated allowlist; empty = all)
//     maxSteps: 8                    (ReAct step budget)
//     ---
//     Persona / operating instructions in plain markdown (the system prompt).
//
// Six built-in presets ship in code so `task` works out of the box:
//   explore · plan · test-writer · refactorer · doc-generator · security-auditor
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from './agent.js';
import { truncate } from '../util.js';
import { enabledPlugins, pluginKindDirs } from '../plugins.js';

export const AGENTS_DIR = '.buddy/agents';
export const RESULT_CHAR_CAP = 8000; // sub-agent report budget back to the main loop

/** Parse one agent markdown file (frontmatter + body). Exported for tests. */
export function parseAgentMd(raw, { fallbackName = '' } = {}) {
  const text = String(raw ?? '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  let body = text;
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
      if (kv) meta[kv[1].trim().toLowerCase()] = kv[2].trim();
    }
    body = m[2];
  }
  const name = String(meta.name || fallbackName).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (!name) return { ok: false, error: 'agent has no name (frontmatter "name:" or filename)' };
  const tools = meta.tools
    ? meta.tools.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean)
    : null; // null = inherit every parent tool
  const maxStepsRaw = Number.parseInt(meta.maxsteps ?? meta.max_steps ?? '', 10);
  return {
    ok: true,
    agent: {
      name,
      description: String(meta.description || '').trim(),
      tools,
      maxSteps: Number.isFinite(maxStepsRaw) && maxStepsRaw > 0 ? Math.min(maxStepsRaw, 24) : 8,
      systemPrompt: body.trim(),
      source: 'user',
    },
  };
}

// ── Built-in presets (shipped so `task` works with zero configuration) ──────

const READ_ONLY_TOOLS = ['fs_list', 'fs_read', 'fs_search', 'bash', 'web_search', 'web_fetch'];

/** Normalize a tools spec (string csv | array | null) into a Set or null. Exported for tests. */
export function normalizeTools(tools) {
  if (!tools) return null;
  const list = Array.isArray(tools)
    ? tools
    : String(tools)
        .split(/[,\s]+/)
        .filter(Boolean);
  return list.length ? new Set(list) : null;
}

const BUILTIN_PRESETS = [
  {
    name: 'explore',
    description: 'Fast read-only code scout — finds where things live, maps structure, answers "where/how" questions. Cheapest way to gather context.',
    tools: READ_ONLY_TOOLS,
    maxSteps: 10,
    systemPrompt: [
      'You are Explore, Engineer Buddy\'s read-only code scout.',
      'You find where things live and how they connect. You have a HARD step budget — plan for convergence, not completeness:',
      '  1. At most 2 fs_search calls, with precise needles (symbol names, not broad words).',
      '  2. Read at most 3 files, narrowly. Never re-read something you already saw.',
      '  3. Then STOP exploring and finish with your report — even if it is partial.',
      'A compact report NOW beats a perfect report never. Report format: the answer first, then the key files/symbols (path:line) as evidence. No filler.',
      'Rules: never modify anything (you have no write tools anyway).',
    ].join('\n'),
  },
  {
    name: 'plan',
    description: 'Read-only architect — turns a task into a concrete step-by-step implementation plan before any code changes.',
    tools: READ_ONLY_TOOLS,
    maxSteps: 10,
    systemPrompt: [
      'You are Planner, Engineer Buddy\'s read-only architect.',
      'Investigate the code enough to ground the plan in reality (read the real files, do not guess), then produce:',
      '1. A short restatement of the goal. 2. The exact files to change and why. 3. Ordered steps, each small and verifiable.',
      '4. Risks/edge cases. 5. How to verify (tests/commands).',
      'Rules: never modify anything. Plans only — no code edits. Keep the plan under 400 words.',
    ].join('\n'),
  },
  {
    name: 'test-writer',
    description: 'Writes or extends tests for a feature/fix, runs them, and reports pass/fail. Can edit test files and run the test command.',
    tools: 'fs_read, fs_search, fs_write, fs_append, fs_replace, bash',
    maxSteps: 12,
    systemPrompt: [
      'You are Test-Writer, Engineer Buddy\'s test specialist.',
      'You write focused tests that match the repo\'s existing style and runner (read first to learn it).',
      'Cover the behavior asked for, plus edge cases worth locking down. Run the tests, then iterate until they pass or you understand the real failure.',
      'Rules: only touch test files unless the task explicitly says otherwise. Report: tests added, result of the run, anything suspicious found.',
    ].join('\n'),
  },
  {
    name: 'refactorer',
    description: 'Behavior-preserving refactor of the named code, verified by the project\'s tests.',
    tools: 'fs_read, fs_search, fs_replace, fs_write, bash',
    maxSteps: 12,
    systemPrompt: [
      'You are Refactorer, Engineer Buddy\'s refactoring specialist.',
      'Improve structure without changing behavior: smaller functions, clearer names, less duplication.',
      'Rules: run the project\'s tests before finishing and report the result. Never change public behavior. Make the smallest change that achieves the refactor cleanly.',
    ].join('\n'),
  },
  {
    name: 'doc-generator',
    description: 'Writes or updates documentation (README sections, API docs, usage examples) from the actual code.',
    tools: 'fs_read, fs_search, fs_write, fs_append',
    maxSteps: 10,
    systemPrompt: [
      'You are Doc-Writer, Engineer Buddy\'s documentation specialist.',
      'Document what the code ACTUALLY does — read it first, never invent APIs or options.',
      'Match the repo\'s existing doc tone and format. Prefer concrete examples over abstract description.',
      'Report: files written and a one-line summary of each.',
    ].join('\n'),
  },
  {
    name: 'security-auditor',
    description: 'Read-only security review of the named scope — injection, secrets, unsafe patterns, auth gaps. Produces findings ranked by severity.',
    tools: READ_ONLY_TOOLS,
    maxSteps: 12,
    systemPrompt: [
      'You are Security-Auditor, Engineer Buddy\'s read-only security reviewer.',
      'Hunt for real, exploitable issues: injection, unsafe deserialization, secret handling, path traversal, SSRF, broken auth/access control, dangerous subprocess use.',
      'Rules: never modify anything. Every finding needs file:line evidence and a concrete fix suggestion. Rank findings HIGH / MEDIUM / LOW. If the scope is clean, say so plainly — do not invent findings.',
    ].join('\n'),
  },
];

/** Built-in preset list (fresh objects each call so callers can mutate safely). */
export function builtinAgents() {
  return BUILTIN_PRESETS.map((a) => ({ ...a, source: 'builtin' }));
}

/**
 * Load every agent available in a workspace: built-in presets, then every
 * enabled plugin's agents/ dir (v0.39.0 §3), then .buddy/agents/*.md —
 * user definitions win on name collisions. Invalid files are skipped with a
 * warning entry so one bad file never breaks the tool set. Exported for tests.
 */
export function loadAgents(root = process.cwd(), { home = os.homedir() } = {}) {
  const byName = new Map(builtinAgents().map((a) => [a.name, a]));
  const warnings = [];
  // One dir of <name>.md personas; later dirs win on name collisions.
  const scanDir = (dir, source) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md'));
    } catch {
      return; /* no such dir — normal */
    }
    for (const ent of entries) {
      const fallbackName = ent.name.replace(/\.md$/, '');
      try {
        const parsed = parseAgentMd(fs.readFileSync(path.join(dir, ent.name), 'utf8'), { fallbackName });
        if (!parsed.ok) {
          warnings.push(`${ent.name} (${source}): ${parsed.error}`);
          continue;
        }
        // overriding a BUILT-IN is the documented merge rule (silent);
        // shadowing another user/plugin definition deserves a warning
        if (byName.has(parsed.agent.name) && byName.get(parsed.agent.name).source !== 'builtin') {
          warnings.push(`agent "${parsed.agent.name}" (${source}) shadows the ${byName.get(parsed.agent.name).source} one`);
        }
        byName.set(parsed.agent.name, parsed.agent);
      } catch (e) {
        warnings.push(`${ent.name} (${source}): ${e.message}`);
      }
    }
  };
  // Plugin layer: enabled plugins contribute their agents/ dirs (project
  // .buddy/agents is scanned after, so the user's own definitions win).
  const { plugins, warnings: pluginWarnings } = enabledPlugins({ root, home });
  warnings.push(...pluginWarnings);
  for (const d of pluginKindDirs(plugins, 'agents')) scanDir(d.dir, `plugin:${d.plugin}`);
  scanDir(path.join(root, AGENTS_DIR), 'project');
  return { agents: [...byName.values()], warnings };
}

/**
 * Run one sub-agent on the bounded ReAct loop. Never throws — every failure
 * becomes a string report (failure isolation is the whole point).
 *
 * @param {object} p
 * @param {object} p.router        GatewayRouter
 * @param {object} p.agent         agent definition (see parseAgentMd)
 * @param {Array}  p.parentTools   the main loop's full tool list
 * @param {string} p.task          the delegated task text
 * @param {number} [p.maxTokens]   per-step completion budget
 * @param {(ev:object)=>void} [p.onStep] step tap for TUI narration
 * @param {(e:object)=>string} [p.approval] optional async gate for risky tools
 * @returns {Promise<string>} the sub-agent's report
 */
export async function runSubagent({ router, agent, parentTools, task, maxTokens = 1500, onStep = null, approval = null, alwaysApproved = null }) {
  const label = `subagent:${agent?.name || '?'}`;
  try {
    if (!router) return 'ERROR: no brain available (router missing)';
    if (!agent || typeof task !== 'string' || !task.trim()) return 'ERROR: agent and task are required';

    // Tool allowlist — and the structural depth limit: `task` is never passed
    // down, so sub-agents cannot spawn sub-agents.
    const allow = normalizeTools(agent.tools);
    const tools = (parentTools || []).filter((t) => t && t.name !== 'task' && (!allow || allow.has(t.name)));
    const unknown = allow ? [...allow].filter((n) => n !== 'task' && !tools.some((t) => t.name === n)) : [];
    if (!tools.length) return `ERROR: agent "${agent.name}" has no usable tools (allowed: ${[...(allow || [])].join(', ') || 'none'})`;

    // Approval gate for risky tools, mirroring the main loop's gate ("always"
    // is remembered per session, shared across sub-agent runs).
    const gatedTools = approval
      ? tools.map((t) => {
          if (!t.risky) return t;
          return {
            ...t,
            run: async (args, ctx) => {
              if (alwaysApproved?.has(t.name)) return t.run(args, ctx);
              const decision = await approval({
                tool: t.name,
                args,
                summary: `${t.name} via ${agent.name} — ${truncate(typeof args === 'string' ? args : JSON.stringify(args ?? {}), 140)}`,
                preview: t.preview ? (() => { try { return t.preview(args); } catch { return null; } })() : null,
              });
              if (decision === 'always') alwaysApproved?.add(t.name);
              if (decision === 'no') return 'DENIED by the user: the action did NOT run. Work without it or finish.';
              return t.run(args, ctx);
            },
          };
        })
      : tools;

    const noteStep = (ev) => {
      if (onStep) {
        try {
          onStep({ agent: agent.name, tool: ev.tool, observation: ev.observation });
        } catch {
          /* narration must never break the run */
        }
      }
    };

    const res = await runAgent({
      router,
      tools: gatedTools,
      systemPrompt: agent.systemPrompt || `You are ${agent.name}, a sub-agent of Engineer Buddy.`,
      messages: [{ role: 'user', content: task.trim() }],
      maxSteps: agent.maxSteps || 8,
      maxTokens,
      onStep: (ev) => noteStep(ev),
    });

    if (res.finished) {
      const out = typeof res.result === 'string' ? res.result : JSON.stringify(res.result);
      return truncate(out && out.trim() ? out : '(sub-agent finished with an empty report)', RESULT_CHAR_CAP);
    }
    // Budget reached without finish — compact salvage: what it DID plus the
    // tail of the last observation. Never paste raw file contents into the
    // parent's context (the v0.8.1 dump ate context and read like noise).
    const toolCounts = new Map();
    for (const s of res.steps) {
      if (s.tool && s.tool !== 'finish') toolCounts.set(s.tool, (toolCounts.get(s.tool) || 0) + 1);
    }
    const did = [...toolCounts.entries()].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ');
    const last = [...res.steps].reverse().find((s) => s.observation);
    return truncate(
      `PARTIAL: ${label} hit its step budget (${agent.maxSteps || 8}) without a final report.` +
        (did ? ` Steps used: ${did}.` : '') +
        (last ? ` Last observation (${last.tool}): ${String(last.observation).replace(/\s+/g, ' ').trim()}` : ' No tool output captured.'),
      RESULT_CHAR_CAP
    );
  } catch (e) {
    return `ERROR: ${label} failed — ${e?.message || e}`;
  }
}
