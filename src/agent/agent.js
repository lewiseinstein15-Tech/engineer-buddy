// agent.js — the Skeleton: a bounded ReAct loop (plan → tool → observe → …
// → finish). Skills compose this with a tool registry. Protocol is strict
// JSON because small free models handle it far better than function-calling:
//   model emits: {"tool":"<name>","args":{...}}  or  {"tool":"finish","result":...}
//
// v0.2 upgrades: one self-repair retry on protocol violation (free models
// sometimes sneeze prose), per-tool call caps, and per-call maxTokens.
// v0.56: an optional `route` hook (multi-model routing) — fn(stepCtx) =>
// chain|null; a truthy chain rides that ONE router.chat as opts.chain.
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
 * @param {((ctx:{index:number,remaining:number,lastTool:string|null})=>Array|null)} [p.route]
 *        v0.56 multi-model routing hook: return a gateway chain for this
 *        step (a permutation of router.order) or null for the default.
 * @returns {{finished:boolean, result:any, steps:Array, history:Array}}
 */
export async function runAgent({ router, tools, systemPrompt, messages, maxSteps = 6, maxTokens = 1200, onStep = null, route = null }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const callCounts = new Map();
  const history = [
    { role: 'system', content: `${systemPromptFor(tools)}\n\n${systemPrompt}` },
    ...messages,
  ];
  const steps = [];

  // v0.56: chain for one step. The route hook owns classification (it sees
  // the same pre-call facts the chat loop sees); a hostile/junk return value
  // degrades to the default order — routing may never break the loop.
  const chainOptFor = (index, lastToolName) => {
    if (typeof route !== 'function') return {};
    try {
      const ctx = { index, remaining: maxSteps - index + 1, lastTool: lastToolName };
      const chain = route(ctx);
      return Array.isArray(chain) && chain.length ? { chain } : {};
    } catch {
      return {};
    }
  };

  const noteStep = (entry) => {
    steps.push(entry);
    if (onStep && entry.tool && entry.observation !== undefined) onStep({ tool: entry.tool, args: entry.args, observation: entry.observation });
  };

  let lastToolName = null; // v0.56: pre-call routing fact for the NEXT step
  for (let i = 1; i <= maxSteps; i++) {
    const chainOpt = chainOptFor(i, lastToolName);
    let { text, model, gateway, latencyMs } = await router.chat(history, { maxTokens, ...chainOpt });
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
      const retry = await router.chat(history, { maxTokens, ...chainOpt });
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
    lastToolName = tool;

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

    // Budget nudges — small free models happily burn the entire budget on
    // exploration and never converge. Tell them loudly BEFORE the last two
    // chances so a real report lands inside the budget (v0.8.2).
    const remaining = maxSteps - i;
    if (remaining === 2) {
      history.push({
        role: 'user',
        content: `BUDGET WARNING: only 2 steps remain (of ${maxSteps}). Wrap up NOW — at most one more short tool call, then finish with your report.`,
      });
    } else if (remaining === 1) {
      history.push({
        role: 'user',
        content: 'FINAL STEP: this is your last step. Do NOT call a tool. Respond with {"tool":"finish","result":...} where result is your complete final report based on what you have gathered.',
      });
    }
  }

  // Budget exhausted without a finish — one forced wrap-up turn: tools are
  // off the table and the model MUST produce its report now. This is what
  // turns "explored for N steps" into an actual answer (v0.8.2).
  const isFinish = (p) => p.ok && p.value && typeof p.value === 'object' && p.value.tool === 'finish';
  try {
    history.push({
      role: 'user',
      content:
        'BUDGET EXHAUSTED: stop calling tools immediately. Reply with EXACTLY ONE JSON object: ' +
        '{"tool":"finish","result":"<your complete final report based on what you gathered so far>"}. ' +
        'A partial answer is required — report what you know now.',
    });
    let wrap = await router.chat(history, { maxTokens, ...chainOptFor(maxSteps + 1, lastToolName) });
    let parsed = extractJson(wrap.text);
    if (!isFinish(parsed)) {
      // one self-repair retry, same contract as the main loop — anything that
      // is still not a finish (prose, or yet another tool call) is a refusal
      history.push({ role: 'assistant', content: truncate(wrap.text, 700) });
      history.push({
        role: 'user',
        content: 'PROTOCOL ERROR: respond again with EXACTLY ONE JSON object: {"tool":"finish","result":"<your final report>"}. No other text. Do NOT call a tool.',
      });
      wrap = await router.chat(history, { maxTokens });
      parsed = extractJson(wrap.text);
      if (!isFinish(parsed)) {
        noteStep({ step: maxSteps + 1, error: 'forced wrap-up did not produce a finish', raw: truncate(wrap.text, 200), model: wrap.model, gateway: wrap.gateway, latencyMs: wrap.latencyMs });
        return { finished: false, result: null, steps, history };
      }
    }
    const payload = parsed.value.result ?? parsed.value.args ?? {};
    noteStep({ step: maxSteps + 1, tool: 'finish', args: {}, observation: '(final report delivered on the forced wrap-up turn)', forced: true, model: wrap.model, gateway: wrap.gateway, latencyMs: wrap.latencyMs });
    return { finished: true, result: payload, steps, history, forcedFinish: true };
  } catch {
    return { finished: false, result: null, steps, history };
  }
}
