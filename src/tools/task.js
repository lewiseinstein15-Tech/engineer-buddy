// task.js — the `task` tool: how Buddy's main loop delegates work to
// specialized sub-agents (Claude Code's Task tool, Buddy edition).
//
// Shape follows the house tool contract {name, description, args, render, run}.
// Safety/budget properties:
//   depth limit  — sub-agents never receive `task` (structural, see subagents.js)
//   per-turn cap — maxCalls bounds how many sub-agent runs one turn may spawn
//   batch cap    — v0.59: one batch call carries at most BATCH_MAX children
//                  (named refusal above it — a step cannot stampede the machine)
//   isolation    — v0.59: a batch runs its children under Promise.allSettled;
//                  one child's crash or junk entry is an ERROR ROW, never a
//                  whole-batch failure, and reports come back in INPUT order
//   gate passthrough — risky tools inside a sub-agent still hit the user's
//                      approval gate, with "always" remembered per session
import { runSubagent, BATCH_MAX } from '../agent/subagents.js';
import { truncate } from '../util.js';

/**
 * Build the task tool.
 * @param {object} p
 * @param {object} p.router        GatewayRouter (passed down to sub-agents)
 * @param {Array}  p.agents        loaded agent definitions (loadAgents().agents)
 * @param {Array}  p.tools         the main loop's tools (passed down, minus `task`)
 * @param {number} [p.maxCalls]    per-turn dispatch budget (default 3)
 * @param {function} [p.approval]  approval gate for risky sub-tools
 * @param {function} [p.onSubEvent] narration tap: {type:'subagent', phase, agent, tool, observation}
 * @param {object} [p.routing] v0.56 multi-model routing config passed to sub-agents
 * @param {string} [p.root] v0.59 workspace root — enables the sub-agent lesson
 *                          recall slice (same engine + firewall as every surface)
 */
export function buildTaskTool({ router, agents, tools, maxCalls = 3, approval = null, onSubEvent = () => {}, routing = null, root = null } = {}) {
  const byName = new Map((agents || []).map((a) => [a.name, a]));
  const alwaysApproved = new Set(); // shared across sub-agent runs in this session
  const agentList = (agents || [])
    .map((a) => `${a.name}${a.description ? ` — ${a.description}` : ''}`)
    .join('; ');

  const runChild = async (def, taskText) =>
    runSubagent({
      router,
      agent: def,
      parentTools: tools,
      task: taskText,
      approval,
      alwaysApproved,
      routing,
      root,
      onStep: (ev) => {
        try {
          onSubEvent({ type: 'subagent', phase: 'step', agent: ev.agent, tool: ev.tool, observation: ev.observation });
        } catch {
          /* narration never breaks the run */
        }
      },
    });

  const finishChild = (name, report) => {
    try {
      onSubEvent({ type: 'subagent', phase: /ERROR|PARTIAL/.test(report) ? 'error' : 'done', agent: name, report });
    } catch {
      /* narration never breaks the run */
    }
  };

  // ── the batch path (v0.59 parallel fan-out) ─────────────────────────────
  // Structure errors refuse the call (teaching); ENTRY errors isolate into
  // per-row ERRORs (one typo must never veto the innocent siblings). The
  // children run CONCURRENTLY; reports land in INPUT order so the parent's
  // context stays deterministic no matter who finishes first.
  // Field reads are getter-safe: a hostile entry that throws on property
  // access is a per-row error, never a whole-batch failure.
  const field = (obj, key) => {
    try {
      return obj?.[key];
    } catch {
      return undefined;
    }
  };
  const runBatch = async (batch) => {
    if (!Array.isArray(batch)) {
      return `ERROR: "batch" must be an ARRAY of {agent, task} objects — e.g. {"batch":[{"agent":"explore","task":"..."},{"agent":"plan","task":"..."}]}. Got ${typeof batch}.`;
    }
    if (!batch.length) return 'ERROR: "batch" is empty — name at least one child ({agent, task}).';
    if (batch.length > BATCH_MAX) {
      return `ERROR: a batch carries at most ${BATCH_MAX} children (got ${batch.length}) — split it into rounds; the dispatch budget exists so one step cannot stampede the machine.`;
    }
    const plan = batch.map((ent, i) => {
      const row = `#${i + 1}`;
      if (!ent || typeof ent !== 'object' || Array.isArray(ent)) {
        return { i, error: `${row}: ERROR: batch entry must be an object {agent, task}` };
      }
      const rawName = field(ent, 'agent');
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      if (!name) return { i, error: `${row}: ERROR: "agent" required — available: ${[...byName.keys()].join(', ')}` };
      const def = byName.get(name);
      if (!def) return { i, error: `${row}: ERROR: unknown agent "${name}" — available: ${[...byName.keys()].join(', ')}` };
      const rawTask = field(ent, 'task');
      const text = typeof rawTask === 'string' ? rawTask.trim() : '';
      if (!text) return { i, error: `${row}: ERROR: "task" required — say exactly what ${name} should do and report back.` };
      return { i, name, def, text };
    });
    const settled = await Promise.allSettled(
      plan.map((p) => (p.error ? Promise.resolve(null) : runChild(p.def, p.text).then((report) => (finishChild(p.name, report), report))))
    );
    return plan
      .map((p, i) => {
        if (p.error) return p.error;
        const s = settled[i];
        const report = s.status === 'fulfilled' ? s.value : `ERROR: ${p.name} crashed — ${s.reason?.message || s.reason}`;
        return `SUB-AGENT REPORT #${i + 1} (${p.name}):\n${report}`;
      })
      .join('\n\n');
  };

  return {
    name: 'task',
    description:
      `Delegate a focused sub-task to a specialized sub-agent. It works in its own context (its edits still affect this repo) and returns one report. Prefer this over doing everything yourself for search-heavy or multi-part work. Agents: ${agentList || '(none loaded)'}. To launch SEVERAL agents concurrently, pass {"batch":[{"agent":"...","task":"..."},...]} (max ${BATCH_MAX}) — they run in parallel and reports come back numbered, in your order.`,
    args: '{"agent":"explore","task":"find every caller of runBash and summarize how they differ"}  |  {"batch":[{"agent":"explore","task":"..."},{"agent":"plan","task":"..."}]}',
    maxCalls,
    render: (a) => {
      if (a && Array.isArray(a.batch)) {
        // every field is MODEL-authored data: a hostile toString must never
        // be able to crash the TUI through a render call
        const names = a.batch
          .map((e) => (e && typeof e === 'object' && typeof e.agent === 'string' ? e.agent : '?'))
          .join(', ');
        return `task ×${a.batch.length}: ${truncate(names, 56)}`;
      }
      const agentName = typeof a?.agent === 'string' ? a.agent : '?';
      const taskText = typeof a?.task === 'string' ? a.task : '';
      return `task → ${agentName}: ${truncate(taskText, 56)}`;
    },
    run: async (a = {}) => {
      if (a && a.batch !== undefined) return runBatch(a.batch);
      // every field is MODEL-authored data — typeof checks, never String()
      // coercion (a hostile toString cannot crash the dispatch)
      const name = typeof a?.agent === 'string' ? a.agent.trim() : '';
      if (!name) return `ERROR: "agent" required — available: ${[...byName.keys()].join(', ')}`;
      const def = byName.get(name);
      if (!def) return `ERROR: unknown agent "${name}" — available: ${[...byName.keys()].join(', ')}`;
      const taskText = typeof a?.task === 'string' ? a.task : '';
      if (!taskText.trim()) return 'ERROR: "task" required — say exactly what the sub-agent should do and report back.';

      const report = await runChild(def, taskText);
      finishChild(name, report);
      return `SUB-AGENT REPORT (${name}):\n${report}`;
    },
  };
}
