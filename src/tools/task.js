// task.js — the `task` tool: how Buddy's main loop delegates work to
// specialized sub-agents (Claude Code's Task tool, Buddy edition).
//
// Shape follows the house tool contract {name, description, args, render, run}.
// Safety/budget properties:
//   depth limit  — sub-agents never receive `task` (structural, see subagents.js)
//   per-turn cap — maxCalls bounds how many sub-agent runs one turn may spawn
//   gate passthrough — risky tools inside a sub-agent still hit the user's
//                      approval gate, with "always" remembered per session
import { runSubagent } from '../agent/subagents.js';
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
 */
export function buildTaskTool({ router, agents, tools, maxCalls = 3, approval = null, onSubEvent = () => {} } = {}) {
  const byName = new Map((agents || []).map((a) => [a.name, a]));
  const alwaysApproved = new Set(); // shared across sub-agent runs in this session
  const agentList = (agents || [])
    .map((a) => `${a.name}${a.description ? ` — ${a.description}` : ''}`)
    .join('; ');

  return {
    name: 'task',
    description:
      `Delegate a focused sub-task to a specialized sub-agent. It works in its own context (its edits still affect this repo) and returns one report. Prefer this over doing everything yourself for search-heavy or multi-part work. Agents: ${agentList || '(none loaded)'}.`,
    args: '{"agent":"explore","task":"find every caller of runBash and summarize how they differ"}',
    maxCalls,
    render: (a) => `task → ${a?.agent || '?'}: ${truncate(String(a?.task ?? ''), 56)}`,
    run: async ({ agent, task } = {}) => {
      const name = String(agent || '').trim();
      if (!name) return `ERROR: "agent" required — available: ${[...byName.keys()].join(', ')}`;
      const def = byName.get(name);
      if (!def) return `ERROR: unknown agent "${name}" — available: ${[...byName.keys()].join(', ')}`;
      if (!task || !String(task).trim()) return 'ERROR: "task" required — say exactly what the sub-agent should do and report back.';

      const report = await runSubagent({
        router,
        agent: def,
        parentTools: tools,
        task: String(task),
        approval,
        alwaysApproved,
        onStep: (ev) => {
          try {
            onSubEvent({ type: 'subagent', phase: 'step', agent: ev.agent, tool: ev.tool, observation: ev.observation });
          } catch {
            /* narration never breaks the run */
          }
        },
      });
      try {
        onSubEvent({ type: 'subagent', phase: /ERROR|PARTIAL/.test(report) ? 'error' : 'done', agent: name, report });
      } catch {
        /* narration never breaks the run */
      }
      return `SUB-AGENT REPORT (${name}):\n${report}`;
    },
  };
}
