// agent.js — the Skeleton: a bounded ReAct loop (plan → tool → observe → …
// → finish). Skills compose this with a tool registry. Protocol is strict
// JSON because small free models handle it far better than function-calling:
//   model emits: {"tool":"<name>","args":{...}}  or  {"tool":"finish","result":...}
import { extractJson, debugLog, truncate } from '../util.js';

export function describeTools(tools) {
  return tools
    .map((t) => `- ${t.name}: ${t.description}${t.args ? `\n  args: ${t.args}` : ''}`)
    .join('\n');
}

export function systemPromptFor(tools) {
  return [
    'You are Engineer Buddy, an autonomous software engineering agent.',
    'You work in strict JSON protocol steps. At each step respond with EXACTLY ONE JSON object and nothing else:',
    '  {"tool":"<tool-name>","args":{...}}   to call a tool, or',
    '  {"tool":"finish","result":{...}}      when the task is complete.',
    'Available tools:',
    describeTools(tools),
    'Rules: never invent tool results. Read before you judge. Prefer fewer, higher-quality steps. JSON only — no markdown fences, no prose.',
  ].join('\n');
}

/**
 * Run the agent loop.
 * @param {object} p
 * @param {object} p.router  GatewayRouter
 * @param {Array}  p.tools   [{name, description, args, run(args)->string}]
 * @param {string} p.systemPrompt  appended after the protocol preamble
 * @param {Array}  p.messages      task messages (user role)
 * @param {number} p.maxSteps
 * @param {(step:{tool,args,observation})=>void} p.onStep  observation tap
 * @returns {{finished:boolean, result:any, steps:Array, history:Array}}
 */
export async function runAgent({ router, tools, systemPrompt, messages, maxSteps = 4, onStep = null }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const history = [
    { role: 'system', content: `${systemPromptFor(tools)}\n\n${systemPrompt}` },
    ...messages,
  ];
  const steps = [];
  for (let i = 1; i <= maxSteps; i++) {
    const { text, model, gateway, latencyMs } = await router.chat(history, { maxTokens: 1024 });
    const parsed = extractJson(text);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || !parsed.value.tool) {
      steps.push({ step: i, error: 'protocol violation', raw: truncate(text, 300), model, gateway, latencyMs });
      break;
    }
    const { tool, args = {} } = parsed.value;
    if (tool === 'finish') {
      steps.push({ step: i, tool, args, model, gateway, latencyMs });
      return { finished: true, result: args.result ?? args, steps, history };
    }
    const impl = byName.get(tool);
    const observation = impl
      ? await impl.run(args).catch((e) => `ERROR: ${e.message}`)
      : `ERROR: unknown tool "${tool}". Available: ${[...byName.keys()].join(', ')}`;
    debugLog(`agent step ${i}: ${tool} → ${truncate(observation, 120)}`);
    steps.push({ step: i, tool, args, observation: truncate(observation, 200), model, gateway, latencyMs });
    if (onStep) onStep({ tool, args, observation });
    history.push({ role: 'assistant', content: JSON.stringify({ tool, args }) });
    history.push({ role: 'user', content: `TOOL OBSERVATION:\n${observation}\n\nContinue with the next JSON step.` });
  }
  return { finished: false, result: null, steps, history };
}
