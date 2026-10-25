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
import { describeSkillCatalog } from '../skills/loader.js';
import { PLAN_TOOLS, planModePrompt } from '../tools/planmode.js';

export const PROTOCOL_PREAMBLE = [
  'You are Engineer Buddy ("Buddy Code"), a software engineer working in the user\'s terminal inside this repository.',
  'Protocol: every reply must be EXACTLY ONE JSON object and nothing else:',
  '  {"tool":"<tool-name>","args":{...}}   to use a tool, or',
  '  {"tool":"say","message":"..."}        to speak to the user and end the turn.',
  'Never output prose outside JSON. Never invent tool results. Never claim you ran a command you did not run.',
].join('\n');

export function buildSystemPrompt({ harness, tools, skills = [], planMode = false }) {
  // Plan mode swaps the visible tool list right here: only research tools +
  // exit_plan stay; normal mode hides exit_plan so the model never sees a
  // tool it cannot use. (Filtering lives here so no caller can forget it.)
  const eff = planMode
    ? tools.filter((t) => PLAN_TOOLS.has(t.name))
    : tools.filter((t) => t.name !== 'exit_plan');
  const hasTodo = eff.some((t) => t.name === 'todo');
  const skillsBlock = describeSkillCatalog(skills);
  return [
    PROTOCOL_PREAMBLE,
    '',
    '## Tools',
    describeTools(eff),
    ...(hasTodo
      ? [
          '',
          '## Plan protocol',
          'For any multi-step task, FIRST call the todo tool with a short plan (max 8 items, all "pending"), then update item statuses ("in_progress" → "done") as you work. Keep texts short.',
        ]
      : []),
    ...(planMode ? ['', planModePrompt()] : []),
    '',
    '## Who you are',
    harness.systemprompt,
    '',
    '## Project memory',
    harness.memory,
    '',
    '## Tool guidance',
    harness.toolGuidance,
    ...(skillsBlock ? ['', skillsBlock] : []),
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
  skills = [], // full skill catalog (Skills v2) — disabled ones stay user-invocable
  charBudget = 48000, // history budget (chars) before compaction
  maxStepsPerTurn = 14,
  maxTokens = 1500,
  approval = null, // async ({tool, summary}) => 'yes' | 'no' | 'always' | null
  modes = null, // shared { plan: boolean } — plan mode when .plan is true
  onEvent = () => {},
}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const alwaysApproved = new Set(); // tools the user said "always" for
  let messages = []; // {role, content}; system prompt inserted lazily
  let compactCount = 0;
  const usage = { calls: 0, charsIn: 0, charsOut: 0, byGateway: {} };

  // System prompt is rebuilt per call: plan mode swaps the tool list (only
  // PLAN_TOOLS + exit_plan visible) and injects the read-only section; normal
  // mode hides exit_plan so the model never sees it when it cannot run it.
  const systemMsg = () => {
    const plan = modes?.plan === true;
    return { role: 'system', content: buildSystemPrompt({ harness, tools, skills, planMode: plan }) };
  };

  const historyChars = () => messages.reduce((n, m) => n + m.content.length, 0);

  async function maybeCompact(force = false) {
    if (!force && historyChars() <= charBudget) return;
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
    const out = await router.chat(history, { maxTokens });
    // Usage telemetry (the /cost surface). Rough char-based accounting.
    usage.calls += 1;
    usage.charsIn += history.reduce((n, m) => n + m.content.length, 0);
    usage.charsOut += (out.text || '').length;
    const gw = out.gateway || 'unknown';
    usage.byGateway[gw] = usage.byGateway[gw] || { calls: 0, charsOut: 0 };
    usage.byGateway[gw].calls += 1;
    usage.byGateway[gw].charsOut += (out.text || '').length;
    return out;
  }

  /** Force a compaction pass now (slash /compact). */
  async function compactNow() {
    const before = compactCount;
    await maybeCompact(true);
    return { compacted: compactCount > before, messages: messages.length };
  }

  /**
   * Run one user turn to completion.
   * @returns {{said:string|null, steps:number}}
   */
  async function turn(userText, { signal = null, skill = null } = {}) {
    messages.push({ role: 'user', content: String(userText) });
    onEvent({ type: 'user', text: String(userText) });
    const callCounts = new Map();
    let said = null;
    // Skills v2: a user-invoked skill with allowed-tools arms the restriction
    // immediately; model-loaded skills arm it when the skill tool succeeds.
    let skillRestriction = null;
    if (skill?.allowedTools?.length) {
      skillRestriction = { name: skill.name, allowed: new Set([...skill.allowedTools, 'skill', 'say']) };
    }

    for (let step = 1; step <= maxStepsPerTurn; step++) {
      if (signal?.aborted) {
        onEvent({ type: 'interrupted', at: step });
        messages.push({ role: 'user', content: '[The user interrupted this turn.] Continue only if they ask again.' });
        return { said: null, steps: step - 1, aborted: true };
      }
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
      let preview = null;
      // Plan mode hard wall: refuse BEFORE caps burn or gates fire.
      if (impl && modes?.plan && !PLAN_TOOLS.has(tool)) {
        observation = `ERROR: plan mode is active — only research tools are allowed (${[...PLAN_TOOLS].join(', ')}). Use fs_search/fs_read/fs_list to investigate, then call exit_plan with your plan.`;
      } else if (!impl) {
        observation = `ERROR: unknown tool "${tool}". Available: ${[...byName.keys()].join(', ')}`;
      } else {
        const cap = impl.maxCalls ?? 6;
        const used = callCounts.get(tool) || 0;
        if (used >= cap) {
          observation = `ERROR: tool "${tool}" already used ${used}/${cap} times this turn. Work differently or say.`;
        } else {
          callCounts.set(tool, used + 1);
          // Skills v2: an active skill restricts this task to its allowed tools.
          if (skillRestriction && !skillRestriction.allowed.has(tool)) {
            observation = `ERROR: the "${skillRestriction.name}" skill restricts this task to tools: ${[...skillRestriction.allowed].join(', ')}. Finish with say, or ask the user to load a different skill.`;
          } else {
            // Claude-Code-style preview: risky tools show WHAT will change before approval.
            try {
              preview = impl.preview ? impl.preview(args) : null;
            } catch {
              preview = null; // a broken preview must never block the gate
            }
            if (impl.risky && approval && !alwaysApproved.has(tool)) {
              const decision = await approval({ tool, args, summary: impl.render ? impl.render(args) : truncate(JSON.stringify(args), 200), preview });
              if (decision === 'always') alwaysApproved.add(tool);
              denied = decision === 'no';
            }
            observation = denied
              ? 'DENIED by the user: the action did NOT run. Ask the user how to proceed or pick another approach.'
              : await impl.run(args, { signal }).catch((e) => `ERROR: ${e.message}`);
            // Loading a skill with allowed-tools arms the restriction for the
            // rest of the turn (the skill tool's success output starts with "SKILL: ").
            if (tool === 'skill' && !denied && String(observation).startsWith('SKILL: ')) {
              const loaded = skills.find((s) => s.name === String(args?.name || '').trim() && !s.disableModelInvocation);
              if (loaded?.allowedTools?.length) {
                skillRestriction = { name: loaded.name, allowed: new Set([...loaded.allowedTools, 'skill', 'say']) };
              }
            }
          }
        }
      }

      debugLog(`chat step ${step}: ${tool}${denied ? ' (denied)' : ''} → ${truncate(observation, 120)}`);
      onEvent({ type: 'tool', tool, args, observation, denied, preview, argText: impl?.render ? String(impl.render(args) || '').slice(0, 200) : '', model: res.model, gateway: res.gateway });
      messages.push({ role: 'assistant', content: JSON.stringify({ tool, args }) });
      messages.push({ role: 'user', content: `TOOL OBSERVATION:\n${observation}\n\nContinue with the next JSON step.` });
    }

    onEvent({ type: 'error', text: `Turn budget reached (${maxStepsPerTurn} steps). I paused mid-task — say "continue" to keep going.` });
    return { said: null, steps: maxStepsPerTurn, error: false };
  }

  return {
    turn,
    compactNow,
    get messages() { return messages; },
    get compactCount() { return compactCount; },
    get alwaysApproved() { return [...alwaysApproved]; },
    historyChars,
    usage() {
      return { ...usage, byGateway: { ...usage.byGateway } };
    },
    resetApprovals() {
      alwaysApproved.clear();
    },
  };
}
