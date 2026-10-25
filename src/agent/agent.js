// agent.js — the Skeleton: a bounded ReAct loop (plan → tool → observe → …
// → finish). Skills compose this with a tool registry. Protocol is strict
// JSON because small free models handle it far better than function-calling:
//   model emits: {"tool":"<name>","args":{...}}  or  {"tool":"finish","result":...}
//
// v0.2 upgrades: one self-repair retry on protocol violation (free models
// sometimes sneeze prose), per-tool call caps, and per-call maxTokens.
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
 * @param {Array}  p.tools   [{name, description, args, run(args)->string, maxCalls?}]
 * @param {string} p.systemPrompt  appended after the protocol preamble
 * @param {Array}  p.messages      task messages (user role)
 * @param {number} p.maxSteps
 * @param {number} p.maxTokens  per-step completion budget
 * @param {(step:{tool,args,observation})=>void} p.onStep  observation tap
 * @returns {{finished:boolean, result:any, steps:Array, history:Array}}
 */
export async function runAgent({ router, tools, systemPrompt, messages, maxSteps = 6, maxTokens = 1200, onStep = null }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const callCounts = new Map();
  const history = [
    { role: 'system', content: `${systemPromptFor(tools)}\n\n${systemPrompt}` },
    ...messages,
  ];
  const steps = [];

  const noteStep = (entry) => {
    steps.push(entry);
    if (onStep && entry.tool && entry.observation !== undefined) onStep({ tool: entry.tool, args: entry.args, observation: entry.observation });
  };

  for (let i = 1; i <= maxSteps; i++) {
    let { text, model, gateway, latencyMs } = await router.chat(history, { maxTokens });
    let parsed = extractJson(text);
    let repaired = false;

    // One self-repair retry: tell the model the protocol and ask again.
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || !parsed.value.tool) {
      debugLog(`agent step ${i}: protocol violation, requesting repair`);
      history.push({ role: 'assistant', content: truncate(text, 700) });
      history.push({
        role: 'user',
        content:
          'PROTOCOL ERROR: your reply was not a single JSON object with a "tool" key. Respond again with EXACTLY ONE JSON object: {"tool":"<name>","args":{...}} or {"tool":"finish","result":...}. No other text.',
      });
      const retry = await router.chat(history, { maxTokens });
      parsed = extractJson(retry.text);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || !parsed.value.tool) {
        noteStep({ step: i, error: 'protocol violation (after repair)', raw: truncate(text, 300), model: retry.model, gateway: retry.gateway, latencyMs });
        break;
      }
      repaired = true;
      ({ text, model, gateway, latencyMs } = retry);
      history.splice(-2); // drop the violation exchange, keep clean history
    }

    const meta = { model, gateway, latencyMs };
    const { tool, args = {} } = parsed.value;

    if (tool === 'finish') {
      // The payload may arrive as {"tool":"finish","result":X} or
      // {"tool":"finish","args":{...}} — accept both shapes.
      const payload = parsed.value.result ?? parsed.value.args ?? args;
      noteStep({ step: i, tool, args, repaired, ...meta });
      return { finished: true, result: payload, steps, history };
    }

    const cap = byName.get(tool)?.maxCalls;
    const used = callCounts.get(tool) || 0;
    const impl = byName.get(tool);
    let observation;
    if (!impl) {
      observation = `ERROR: unknown tool "${tool}". Available: ${[...byName.keys()].join(', ')}`;
    } else if (cap && used >= cap) {
      observation = `ERROR: tool "${tool}" already used ${used}/${cap} times this run. Choose a different approach or finish.`;
    } else {
      callCounts.set(tool, used + 1);
      observation = await impl.run(args).catch((e) => `ERROR: ${e.message}`);
    }

    debugLog(`agent step ${i}: ${tool} → ${truncate(observation, 120)}`);
    noteStep({ step: i, tool, args, observation: truncate(observation, 200), repaired, ...meta });
    history.push({ role: 'assistant', content: JSON.stringify({ tool, args }) });
    history.push({ role: 'user', content: `TOOL OBSERVATION:\n${observation}\n\nContinue with the next JSON step.` });
  }
  return { finished: false, result: null, steps, history };
}
