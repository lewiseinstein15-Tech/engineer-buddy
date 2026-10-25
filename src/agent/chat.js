// chat.js — Buddy Code: the conversational agentic loop.
//
// Unlike skills/agent.js (bounded ReAct for one-shot CI tasks), this is a
// multi-turn session loop: the model talks, uses tools, gets observations,
// and eventually "say"s a message to the user — then the user speaks again.
// Same strict-JSON protocol as v0.2 (small free models handle it far better
// than function-calling), extended with:
//   - approval gates for risky tools (write/replace/append/bash)
//   - context compaction (Harness² "evidence stays small in context" rule)
//   - per-turn tool call caps + one protocol-repair retry (v0.2 heritage)
import { extractJson, debugLog, truncate } from '../util.js';
import { describeTools } from './agent.js';

export const PROTOCOL_PREAMBLE = [
  'You are Engineer Buddy ("Buddy Code"), a software engineer working in the user\'s terminal inside this repository.',
  'Protocol: every reply must be EXACTLY ONE JSON object and nothing else:',
  '  {"tool":"<tool-name>","args":{...}}   to use a tool, or',
  '  {"tool":"say","message":"..."}        to speak to the user and end the turn.',
  'Never output prose outside JSON. Never invent tool results. Never claim you ran a command you did not run.',
].join('\n');

export function buildSystemPrompt({ harness, tools }) {
  return [
    PROTOCOL_PREAMBLE,
    '',
    '## Tools',
    describeTools(tools),
    '',
    '## Who you are',
    harness.systemprompt,
    '',
    '## Project memory',
    harness.memory,
    '',
    '## Tool guidance',
    harness.toolGuidance,
    '',
    '## Guardrails',
    harness.guardrails,
  ].join('\n');
}

/** Build a chat session. Returns { turn } plus introspection accessors. */
export function createChat({
  router,
  tools,
  harness,
  charBudget = 48000, // history budget (chars) before compaction
  maxStepsPerTurn = 14,
  maxTokens = 1500,
  approval = null, // async ({tool, summary}) => 'yes' | 'no' | 'always' | null
  onEvent = () => {},
}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const alwaysApproved = new Set(); // tools the user said "always" for
  let messages = []; // {role, content}; system prompt inserted lazily
  let compactCount = 0;

  const systemMsg = () => ({ role: 'system', content: buildSystemPrompt({ harness, tools }) });

  const historyChars = () => messages.reduce((n, m) => n + m.content.length, 0);

  async function maybeCompact() {
    if (historyChars() <= charBudget) return;
    const keep = 4;
    const head = messages.slice(0, Math.max(0, messages.length - keep));
    const tail = messages.slice(-keep);
    if (head.length < 2) return;
    try {
      const { text } = await router.chat(
        [
          {
            role: 'user',
            content:
              `Summarize this engineering conversation in at most 220 words. Keep: the current task, decisions made, files changed, commands run and their outcomes, open questions. Plain text only.\n\n` +
              truncate(head.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n'), 40000),
          },
        ],
        { maxTokens: 600 }
      );
      if (!text || !text.trim()) return;
      messages = [{ role: 'user', content: `[Earlier conversation, summarized]\n${text.trim()}` }, ...tail];
      compactCount++;
      onEvent({ type: 'compaction', kept: tail.length, dropped: head.length });
      debugLog(`chat: compacted ${head.length} messages into a summary`);
    } catch (e) {
      debugLog(`chat: compaction skipped (${e.message})`);
    }
  }

  async function callModel() {
    await maybeCompact();
    const history = [systemMsg(), ...messages];
    return router.chat(history, { maxTokens });
  }

  /**
   * Run one user turn to completion.
   * @returns {{said:string|null, steps:number}}
   */
  async function turn(userText) {
    messages.push({ role: 'user', content: String(userText) });
    onEvent({ type: 'user', text: String(userText) });
    const callCounts = new Map();
    let said = null;

    for (let step = 1; step <= maxStepsPerTurn; step++) {
      let res;
      try {
        res = await callModel();
      } catch (e) {
        onEvent({ type: 'error', text: `brain offline: ${e.message}` });
        return { said: null, steps: step - 1, error: true };
      }

      let parsed = extractJson(res.text);
      // One protocol-repair retry (v0.2 heritage) for free-model sneezes.
      if (!parsed.ok || typeof parsed.value !== 'object' || !parsed.value || !parsed.value.tool) {
        debugLog(`chat step ${step}: protocol violation, requesting repair`);
        messages.push({ role: 'assistant', content: truncate(res.text, 700) });
        messages.push({
          role: 'user',
          content:
            'PROTOCOL ERROR: your reply was not a single JSON object with a "tool" key. Reply again with EXACTLY ONE JSON object: {"tool":"<name>","args":{...}} or {"tool":"say","message":"..."}. No other text.',
        });
        let retry;
        try {
          retry = await callModel();
        } catch (e) {
          onEvent({ type: 'error', text: `brain offline: ${e.message}` });
          return { said: null, steps: step, error: true };
        }
        parsed = extractJson(retry.text);
        if (!parsed.ok || typeof parsed.value !== 'object' || !parsed.value || !parsed.value.tool) {
          messages.splice(-2);
          onEvent({ type: 'error', text: `I could not format my own reply (protocol violation). Raw: ${truncate(res.text, 160)}` });
          return { said: null, steps: step, error: true };
        }
        res = retry;
        messages.splice(-2); // drop the violation exchange, keep clean history
      }

      const { tool, args = {} } = parsed.value;

      // say / finish → speak to the user, end the turn. Both shapes are
      // accepted ("message" may arrive at top level or in args; same for
      // "finish" with "result" — v0.2's finish-payload lesson).
      if (tool === 'say' || tool === 'finish') {
        const raw = args.message ?? parsed.value.message ?? args.result ?? parsed.value.result;
        const msg = typeof raw === 'string' && raw.trim() ? raw : raw ? truncate(JSON.stringify(raw), 1500) : '(empty reply)';
        said = String(msg);
        messages.push({ role: 'assistant', content: JSON.stringify({ tool: 'say', message: said }) });
        onEvent({ type: 'say', text: said });
        return { said, steps: step };
      }

      const impl = byName.get(tool);
      let observation;
      let denied = false;
      if (!impl) {
        observation = `ERROR: unknown tool "${tool}". Available: ${[...byName.keys()].join(', ')}`;
      } else {
        const cap = impl.maxCalls ?? 6;
        const used = callCounts.get(tool) || 0;
        if (used >= cap) {
          observation = `ERROR: tool "${tool}" already used ${used}/${cap} times this turn. Work differently or say.`;
        } else {
          callCounts.set(tool, used + 1);
          if (impl.risky && approval && !alwaysApproved.has(tool)) {
            const decision = await approval({ tool, summary: impl.render ? impl.render(args) : truncate(JSON.stringify(args), 200) });
            if (decision === 'always') alwaysApproved.add(tool);
            denied = decision === 'no';
          }
          observation = denied
            ? 'DENIED by the user: the action did NOT run. Ask the user how to proceed or pick another approach.'
            : await impl.run(args).catch((e) => `ERROR: ${e.message}`);
        }
      }

      debugLog(`chat step ${step}: ${tool}${denied ? ' (denied)' : ''} → ${truncate(observation, 120)}`);
      onEvent({ type: 'tool', tool, args, observation, denied, model: res.model, gateway: res.gateway });
      messages.push({ role: 'assistant', content: JSON.stringify({ tool, args }) });
      messages.push({ role: 'user', content: `TOOL OBSERVATION:\n${observation}\n\nContinue with the next JSON step.` });
    }

    onEvent({ type: 'error', text: `Turn budget reached (${maxStepsPerTurn} steps). I paused mid-task — say "continue" to keep going.` });
    return { said: null, steps: maxStepsPerTurn, error: false };
  }

  return {
    turn,
    get messages() { return messages; },
    get compactCount() { return compactCount; },
    get alwaysApproved() { return [...alwaysApproved]; },
    historyChars,
  };
}
