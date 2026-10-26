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
import { extractJson, tryRepairJson, debugLog, truncate } from '../util.js';
import { describeTools } from './agent.js';
import { describeSkillCatalog } from '../skills/loader.js';
import { PLAN_TOOLS, planModePrompt } from '../tools/planmode.js';
import { evaluatePermission, matchingRule, auditTrail } from '../permissions.js';
import { estimateTokens } from '../brain/usage.js';

export const PROTOCOL_PREAMBLE = [
  'You are Engineer Buddy ("Buddy Code"), a software engineer working in the user\'s terminal inside this repository.',
  'Protocol: every reply must be EXACTLY ONE JSON object and nothing else:',
  '  {"tool":"<tool-name>","args":{...}}   to use a tool, or',
  '  {"tool":"say","message":"..."}        to speak to the user and end the turn.',
  'Never output prose outside JSON. Never invent tool results. Never claim you ran a command you did not run.',
].join('\n');

// Research-repeat guard (v0.9.3 live test: kilo ran fs_search "todo" six
// identical times, burned its own 6/6 cap, and wasted ~8 of 14 steps).
// Exact-repeat calls on read-only research tools get a nudge in the
// observation instead of silently returning the same result again.
const REPEAT_HINT_TOOLS = new Set(['fs_search', 'fs_read', 'fs_list', 'web_search', 'web_fetch']);

// Auto-compact threshold (P1): compaction used to wait until the history hit
// 100% of the budget — the turn that hit the wall paid for the FULL window
// before shrinking, and gateway token caps punished the biggest turns the
// most. Now the loop compacts proactively at ~80% and keeps the hard wall as
// a backstop. Exported for tests and the /context surface.
export const AUTO_COMPACT_AT = 0.8;

export function buildSystemPrompt({ harness, tools, skills = [], planMode = false, repoMap = '' }) {
  // Plan mode swaps the visible tool list right here: only research tools +
  // exit_plan stay; normal mode hides exit_plan so the model never sees a
  // tool it cannot use. (Filtering lives here so no caller can forget it.)
  const eff = planMode
    ? tools.filter((t) => PLAN_TOOLS.has(t.name))
    : tools.filter((t) => t.name !== 'exit_plan');
  const hasTodo = eff.some((t) => t.name === 'todo');
  const skillsBlock = describeSkillCatalog(skills);
  const map = String(repoMap || '').trim();
  return [
    PROTOCOL_PREAMBLE,
    // Repo map (aider-style): orientation before the first research step —
    // the model sees the repo's shape and top symbols without burning a
    // fs_list step on it. A hint, never the truth (files move).
    ...(map ? ['', '## Repo map', map] : []),
    '',
    '## Tools',
    describeTools(eff),
    ...(hasTodo
      ? [
          '',
          '## Plan protocol',
          'For any multi-step task, FIRST call the todo tool with a short plan (max 8 items, all "pending"), then update item statuses ("in_progress" → "done") as you work. Keep texts short.',
          'Items may carry ids and dependencies: {"id":"2","text":"fix it","status":"pending","blocked_by":["1"]} — an item with blockers cannot start or finish until every blocker is "done". The reply lists READY NOW items; start with those. An empty items array clears the plan.',
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
  todoState = null, // shared { latest: [...] | null } — todo v2 state, kept through compaction
  repoMap = null, // () => string | string — aider-style repo map injected into the system prompt
  hooks = null, // HookRunner (src/hooks.js) — user-defined lifecycle commands; null = unconfigured
  permissions = null, // rules engine (src/permissions.js) — deny/allow/defaultMode policy
  yolo = false, // /yolo or CLI flag — flips remaining 'ask' verdicts to allow
  root = process.cwd(), // workspace root — the audit trail lives here
  effort = null, // mutable { level, maxSteps, maxTokens } — /effort low|medium|high retunes the loop live
  streaming = null, // mutable { enabled: boolean } — /stream on|off; deltas flow only when truthy-enabled AND onStream is set
  onStream = null, // (fragment: string) => void — raw gateway deltas as they arrive (TUI thought line); null = buffered chat
  onEvent = () => {},
}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const alwaysApproved = new Set(); // tools the user said "always" for
  let messages = []; // {role, content}; system prompt inserted lazily
  let compactCount = 0;
  // Anti-churn guard: auto-compaction needs a few fresh messages since the
  // last one (the v0.9.4 live test saw SEVEN compactions churn one turn).
  // The hard wall (>100%) and /compact bypass it.
  let lastCompactLen = 0;
  // Task anchor: long compaction churn can dissolve the user's task into a
  // summary-of-summaries (v0.9.4 live test: seven compactions in one turn and
  // kilo planned the WRONG task). The current task is pinned into every
  // compaction summary. Short follow-ups ("continue", "go on") keep the
  // previous anchor instead of replacing it.
  let currentTask = '';
  // Image input (P1): attached images live in a side store keyed by a
  // placeholder token; history keeps ONLY the token text, so compaction,
  // budget accounting and the JSON protocol stay string-shaped. At call time
  // the router expands tokens into vision content for gateways that can see
  // (and strips them for gateways that can't). FIFO-capped so a long session
  // can't hoard base64 forever.
  const imageStore = new Map();
  const IMAGE_TOKEN_RE = /⟪img:[^⟫]*⟫/g;
  // Effort levels (v0.25.0): low = quick chores (fewer steps, tighter
  // replies), medium = the historic defaults, high = hard tasks (more steps,
  // more reply room). Mutable by reference so /effort retunes the NEXT turn
  // without rebuilding the session.
  const effortRef = effort || { level: 'medium', maxSteps: maxStepsPerTurn, maxTokens };
  // Streaming toggle (v0.28.0): mutable by reference so /stream flips the
  // NEXT brain call without rebuilding the session. Default on — one-shot
  // and non-TUI callers simply never pass onStream, so nothing changes.
  const streamingRef = streaming || { enabled: true };
  // Per-task usage ledger (v0.25.0): /cost shows the whole session; this
  // shows what EACH task cost — the $0 story per line item ("this refactor:
  // 9 brain calls, ~41k tok in, ~3k out, 52s"). Diff of the accumulators
  // around the turn — zero double-counting with compaction calls included.
  const tasks = [];
  const TASK_LOG_CAP = 100;
  function registerImage(name, dataUrl) {
    const token = `⟪img:${imageStore.size + 1}:${name}⟫`;
    imageStore.set(token, dataUrl);
    while (imageStore.size > 8) {
      imageStore.delete(imageStore.keys().next().value);
    }
    return token;
  }
  // Real token accounting (P1): gateway-reported usage when the API provides
  // it, chars ÷ 4 estimate when it doesn't — and /cost says which. Compaction
  // calls count too: they are real brain calls with real prompt sizes.
  const usage = { calls: 0, charsIn: 0, charsOut: 0, tokIn: 0, tokOut: 0, reportedCalls: 0, estimatedCalls: 0, byGateway: {} };
  function recordUsage(out, charsIn, charsOut) {
    usage.calls += 1;
    usage.charsIn += charsIn;
    usage.charsOut += charsOut;
    const u = out?.usage;
    const reported = u && (u.promptTokens > 0 || u.completionTokens > 0);
    const tokIn = reported ? u.promptTokens : estimateTokens(charsIn);
    const tokOut = reported ? u.completionTokens : estimateTokens(charsOut);
    usage.tokIn += tokIn;
    usage.tokOut += tokOut;
    if (reported) usage.reportedCalls += 1;
    else usage.estimatedCalls += 1;
    const gw = out?.gateway || 'unknown';
    const g = (usage.byGateway[gw] = usage.byGateway[gw] || { calls: 0, charsOut: 0, tokIn: 0, tokOut: 0, reportedCalls: 0 });
    g.calls += 1;
    g.charsOut += charsOut;
    g.tokIn += tokIn;
    g.tokOut += tokOut;
    if (reported) g.reportedCalls += 1;
  }

  // System prompt is rebuilt per call: plan mode swaps the tool list (only
  // PLAN_TOOLS + exit_plan visible) and injects the read-only section; normal
  // mode hides exit_plan so the model never sees it when it cannot run it.
  const systemMsg = () => {
    const plan = modes?.plan === true;
    const map = typeof repoMap === 'function' ? repoMap() : repoMap || '';
    return { role: 'system', content: buildSystemPrompt({ harness, tools, skills, planMode: plan, repoMap: map }) };
  };

  const historyChars = () => messages.reduce((n, m) => n + m.content.length, 0);

  async function maybeCompact(force = false) {
    const chars = historyChars();
    if (force) {
      // /compact — always tries.
    } else {
      const soft = chars > charBudget * AUTO_COMPACT_AT;
      const hard = chars > charBudget; // backstop: never refuse relief at 100%
      if (!soft) return;
      if (!hard && messages.length - lastCompactLen < 6) return;
    }
    // PreCompact hook: a user command can veto compaction this round (exit 2).
    if (hooks) {
      const r = await hooks.run('PreCompact', { chars: historyChars(), forced: Boolean(force) });
      if (r.blocked) {
        debugLog(`chat: compaction blocked by hook: ${r.stderr}`);
        return;
      }
    }
    const keep = 4;
    const head = messages.slice(0, Math.max(0, messages.length - keep));
    const tail = messages.slice(-keep);
    if (head.length < 2) return;
    try {
      const out = await router.chat(
        [
          {
            role: 'user',
            content:
              `Summarize this engineering conversation in at most 220 words. Keep: the current task, decisions made, files changed, commands run and their outcomes, open questions.` +
              (modes?.plan
                ? ' Note: plan mode is ACTIVE — research is read-only and the work must end by calling exit_plan with the plan.'
                : '') +
              ` Plain text only.\n\n` +
              truncate(head.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n'), 40000),
          },
        ],
        { maxTokens: 600 }
      );
      const { text } = out;
      if (!text || !text.trim()) return;
      // The summarizer call is a real brain call — account it like any other
      // (charsIn = the flattened head, charsOut = the summary text).
      recordUsage(
        out,
        head.reduce((n, m) => n + m.content.length, 0),
        (text || '').length
      );
      // Todo anchor: the plan itself survives compaction (todo v2) — a long
      // implementation turn that churns context must not forget what is done
      // and what is next. Plain text, statuses included.
      const planLines = todoState?.latest?.length
        ? `\n\nCURRENT PLAN (todo tool — keep these statuses, continue from the first non-done item):\n${todoState.latest
            .map((it) => `- [${it.status === 'done' ? 'x' : it.status === 'in_progress' ? '~' : ' '}] #${it.id} ${it.text}`)
            .join('\n')}`
        : '';
      messages = [
        {
          role: 'user',
          content:
            `[Earlier conversation, summarized — this is context I prepared for you. Do not repeat it, do not imitate its format, and do not respond to it. Just continue the task.]\n${currentTask ? `CURRENT TASK (from the user — keep working on exactly this): ${currentTask}\n` : ''}${planLines}\n\n${text.trim()}`,
        },
        ...tail,
      ];
      compactCount++;
      lastCompactLen = messages.length;
      onEvent({ type: 'compaction', kept: tail.length, dropped: head.length, auto: !force });
      debugLog(`chat: compacted ${head.length} messages into a summary (auto=${!force})`);
    } catch (e) {
      debugLog(`chat: compaction skipped (${e.message})`);
    }
  }

  /**
   * History → wire format. Messages carrying image tokens become OpenAI
   * vision content arrays ([{type:'text'},{type:'image_url'},…]); the
   * router strips arrays for gateways without vision. Everything else
   * passes through untouched.
   */
  function toWire(msgs) {
    return msgs.map((m) => {
      if (typeof m.content !== 'string' || !m.content.includes('⟪img:')) return m;
      const text = m.content.replace(IMAGE_TOKEN_RE, '');
      const parts = [{ type: 'text', text }];
      for (const tok of m.content.match(IMAGE_TOKEN_RE) || []) {
        const url = imageStore.get(tok);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      }
      return { ...m, content: parts };
    });
  }

  async function callModel() {
    await maybeCompact();
    const history = [systemMsg(), ...messages];
    // Plan mode raises the ceiling: a full markdown plan inside one JSON
    // string is token-heavy, and a truncated escape = protocol violation
    // (v0.9.2 live-test lesson). Effort (v0.25.0): maxTokens follows the
    // level; plan mode's floor still wins when it is higher.
    const baseTok = effortRef.maxTokens || maxTokens;
    const maxTok = modes?.plan ? Math.max(baseTok, 2500) : baseTok;
    // Streaming thoughts (v0.28.0): when the TUI listens and the toggle is
    // on, gateways get onDelta and push raw fragments out as they arrive.
    // The reply is still assembled from the FULL text — deltas never change
    // parsing, only how alive the wait looks. One-shot/CI (no onStream) and
    // /stream off both take the untouched buffered path.
    const wantStream = Boolean(onStream) && streamingRef?.enabled !== false;
    const out = await router.chat(toWire(history), {
      maxTokens: maxTok,
      ...(wantStream ? { onDelta: (frag) => onStream(String(frag ?? '')) } : {}),
    });
    // Usage telemetry (the /cost surface) — real tokens when the gateway
    // reports them, chars ÷ 4 estimate otherwise.
    recordUsage(
      out,
      history.reduce((n, m) => n + m.content.length, 0),
      (out.text || '').length
    );
    return out;
  }

  /** Force a compaction pass now (slash /compact). */
  async function compactNow() {
    const before = compactCount;
    await maybeCompact(true);
    return { compacted: compactCount > before, messages: messages.length };
  }

  /**
   * Run one user turn to completion (wrapped by turn() for the task ledger).
   * @returns {{said:string|null, steps:number}}
   */
  async function turnImpl(userText, { signal = null, skill = null, anchor = null, images = [] } = {}) {
    // UserPromptSubmit hook: exit 2 refuses the prompt BEFORE it enters the
    // conversation or costs a brain call (deterministic gatekeeper).
    if (hooks) {
      const r = await hooks.run('UserPromptSubmit', { prompt: String(userText) });
      if (r.blocked) {
        onEvent({ type: 'error', text: `prompt blocked by hook: ${r.stderr}` });
        return { said: null, steps: 0, error: true, hookBlocked: true };
      }
    }
    // Image attachments (v0.13.3): history keeps one placeholder line per
    // image; the dataUrl rides in the side store (≤2 per task, FIFO store).
    let userContent = String(userText);
    for (const img of (Array.isArray(images) ? images : []).slice(0, 2)) {
      if (!img?.dataUrl) continue;
      const token = registerImage(String(img.name || 'image'), img.dataUrl);
      userContent += `\n[image attached: ${img.name || 'image'}] ${token}`;
    }
    messages.push({ role: 'user', content: userContent });
    onEvent({ type: 'user', text: String(userText) });
    // Task anchor: real tasks pin/replace; short follow-ups ("continue",
    // "go on", "yes") keep the previous anchor so compaction keeps the goal.
    // The anchor can be overridden (@file mentions: anchor the RAW task, not
    // the message with the whole attachment block — otherwise every compaction
    // summary would re-embed thousands of chars of attached file).
    const taskText = String(anchor ?? userText).trim();
    if (taskText.length > 20 || !currentTask) currentTask = taskText;
    const callCounts = new Map();
    const lastArgs = new Map(); // research-repeat guard: tool -> JSON of last args
    let said = null;
    // Skills v2: a user-invoked skill with allowed-tools arms the restriction
    // immediately; model-loaded skills arm it when the skill tool succeeds.
    let skillRestriction = null;
    if (skill?.allowedTools?.length) {
      skillRestriction = { name: skill.name, allowed: new Set([...skill.allowedTools, 'skill', 'say']) };
    }
    // Dynamic loop bound: an approved plan grants fresh steps so the approval
    // can flow straight into implementation (planmode.js contract). Effort
    // (v0.25.0): the level owns the base step budget.
    let stepLimit = effortRef.maxSteps || maxStepsPerTurn;
    let planNudged = false; // mid-turn wrap-up nudge fires once

    for (let step = 1; step <= stepLimit; step++) {
      if (signal?.aborted) {
        onEvent({ type: 'interrupted', at: step });
        messages.push({ role: 'user', content: '[The user interrupted this turn.] Continue only if they ask again.' });
        return { said: null, steps: step - 1, aborted: true };
      }
      // Plan-mode wrap-up pressure (v0.9.2 live-test lesson: kilo researched
      // for 11 steps, then wrote the plan as prose → protocol violation, and
      // no plan ever reached the gate). Mid-turn nudge at ~step 8 (v0.9.4
      // lesson: kilo drifted 12 steps and ended with a progress-report say),
      // then the forced door on the last step.
      const midStep = Math.min(8, maxStepsPerTurn - 1);
      if (modes?.plan && !planNudged && midStep >= 1 && step === midStep) {
        planNudged = true;
        messages.push({
          role: 'user',
          content:
            'PLAN MODE: you have used enough research steps. Stop researching and call exit_plan NOW with the best plan you have so far. The user can ask you to refine after seeing it.',
        });
      }
      if (modes?.plan && step === stepLimit) {
        messages.push({
          role: 'user',
          content:
            'PLAN MODE FINAL STEP: you are on your last step. Stop researching and call exit_plan NOW with the best plan you can write from your research so far. Deliver the plan ONLY through exit_plan — never as a plain-text reply.',
        });
      }
      let res;
      try {
        res = await callModel();
      } catch (e) {
        onEvent({ type: 'error', text: `brain offline: ${e.message}` });
        return { said: null, steps: step - 1, error: true };
      }

      let salvaged = false;
      let parsed = extractJson(res.text);
      // Layer 1 — sloppy-JSON repair (ALL modes): small models emit literal
      // newlines/tabs inside string values, which is invalid JSON (kilo's
      // v0.9.3 live test: a whole say-message with markdown headers and real
      // newlines). Cheapest, most faithful fix — recover it before anything
      // else so the reply means what the model intended.
      {
        const broken = !parsed.ok || typeof parsed.value !== 'object' || !parsed.value || !parsed.value.tool;
        if (broken) {
          const fixed = tryRepairJson(res.text);
          if (fixed && fixed.tool) parsed = { ok: true, value: fixed };
        }
      }
      // Layer 2 — plan-mode prose salvage (v0.9.2 live-test lesson): free
      // models often hand the plan over as prose — escaping a long markdown
      // plan into a single JSON string is exactly what they fail at. In plan
      // mode that prose IS the plan: route it into the exit_plan gate instead
      // of failing the turn. The user still decides at the gate (approve →
      // implement, deny → refine). GUARD (v0.9.3 lesson): never salvage a
      // reply that starts with '{' — that is a broken JSON tool call, not a
      // plan; salvaging one approved a junk plan and flipped plan mode off.
      if (modes?.plan) {
        const raw = String(res.text || '').trim();
        const broken = !parsed.ok || typeof parsed.value !== 'object' || !parsed.value || !parsed.value.tool;
        if (broken && raw.length >= 80 && !raw.startsWith('{')) {
          parsed = {
            ok: true,
            value: { tool: 'exit_plan', args: { summary: truncate(raw.split('\n')[0], 80), plan: raw } },
          };
          salvaged = true;
        }
      }
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
        const retryBroken = !parsed.ok || typeof parsed.value !== 'object' || !parsed.value || !parsed.value.tool;
        if (retryBroken) {
          const fixed = tryRepairJson(retry.text);
          if (fixed && fixed.tool) parsed = { ok: true, value: fixed };
        }
        if (!parsed.ok || typeof parsed.value !== 'object' || !parsed.value || !parsed.value.tool) {
          messages.splice(-2);
          onEvent({ type: 'error', text: `I could not format my own reply (protocol violation). Raw: ${truncate(res.text, 160)}` });
          return { said: null, steps: step, error: true };
        }
        res = retry;
        messages.splice(-2); // drop the violation exchange, keep clean history
      }

      const { tool, args = {} } = parsed.value;

      // v0.2 heritage: models put payload fields at the top level instead of
      // inside args (the say/finish lesson). exit_plan gets the same
      // tolerance so a good plan is never lost to a shape mistake.
      if (tool === 'exit_plan') {
        if (args.plan === undefined && parsed.value.plan !== undefined) args.plan = parsed.value.plan;
        if (args.summary === undefined && parsed.value.summary !== undefined) args.summary = parsed.value.summary;
      }

      // say / finish → speak to the user, end the turn. Both shapes are
      // accepted ("message" may arrive at top level or in args; same for
      // "finish" with "result" — v0.2's finish-payload lesson).
      if (tool === 'say' || tool === 'finish') {
        const raw = args.message ?? parsed.value.message ?? args.result ?? parsed.value.result;
        const msg = typeof raw === 'string' && raw.trim() ? raw : raw ? truncate(JSON.stringify(raw), 1500) : '(empty reply)';
        said = String(msg);
        messages.push({ role: 'assistant', content: JSON.stringify({ tool: 'say', message: said }) });
        onEvent({ type: 'say', text: said });
        if (hooks) hooks.fireAndForget('Stop', { said }); // exit 2 is advisory only here (v1)
        auditTrail(root, { tool, args: truncate(JSON.stringify(args ?? {}), 200), denied: false, verdict: 'said' });
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
          observation = `ERROR: tool "${tool}" already used ${used}/${cap} times this turn. Work differently${modes?.plan ? ', say, or call exit_plan with the plan you have' : ' or say'}.`;
        } else {
          // Hooks run BEFORE the cap is burned, the gate fires, or anything
          // executes — the deterministic guarantee layer (exit 2 = block).
          if (hooks) {
            const hr = await hooks.run('PreToolUse', { tool, args });
            if (hr.blocked) {
              observation = `BLOCKED by hook: ${hr.stderr}\nDo not retry the exact same call — change your approach or ask the user to review .buddy/settings.json.`;
            }
          }
          if (observation === undefined) {
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
            // Rules engine (v0.19.0): deny refuses outright, allow skips the
            // gate, ask falls through to the interactive approval.
            const verdict = evaluatePermission(permissions, tool, args, { yolo });
            if (verdict === 'deny') {
              const rule = matchingRule(permissions, tool, args, 'deny');
              observation = `REFUSED by a permissions rule (${rule}) — this is policy from .buddy/settings.json, not a judgment call. Pick a different approach or ask the user to change the rules.`;
              denied = true;
            } else if ((typeof impl.riskyWhen === 'function' ? !!impl.riskyWhen(args) : !!impl.risky) && approval && !alwaysApproved.has(tool) && verdict === 'ask') {
              const decision = await approval({ tool, args, summary: impl.render ? impl.render(args) : truncate(JSON.stringify(args), 200), preview });
              if (decision === 'always') alwaysApproved.add(tool);
              denied = decision === 'no';
            }
            observation = denied
              ? verdict === 'deny'
                ? observation // the rules-engine refusal already says WHY (which rule)
                : 'DENIED by the user: the action did NOT run. Ask the user how to proceed or pick another approach.'
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
      }

      // Research-repeat guard: exact same tool + args as earlier this turn →
      // prepend a nudge instead of silently returning the same result.
      if (REPEAT_HINT_TOOLS.has(tool) && !denied) {
        const key = JSON.stringify(args);
        if (lastArgs.get(tool) === key) {
          observation = `NOTE: identical repeat of ${tool} — same arguments, same result. Change the query/arguments, pick a different tool, or wrap up.\n\n${observation}`;
        }
        lastArgs.set(tool, key);
      }

      // PostToolUse hook: sees the final observation; exit 2 appends the
      // hook's stderr as a visible note (audit-and-annotate, not a veto —
      // the tool already ran).
      if (hooks) {
        const hr = await hooks.run('PostToolUse', { tool, args, observation: truncate(String(observation), 2000), denied });
        if (hr.blocked) observation = `${observation}\n[hook] ${hr.stderr}`;
        // OnError: Buddy's extension — deterministic reactions to tool failures.
        if (!denied && String(observation).startsWith('ERROR')) hooks.fireAndForget('OnError', { tool, args, observation: truncate(String(observation), 2000) });
      }

      // Audit trail (v0.19.0): every file/command operation, append-only.
      auditTrail(root, { tool, args: truncate(JSON.stringify(args ?? {}), 200), denied, verdict: String(observation).startsWith('ERROR') || denied ? 'refused-or-failed' : 'ran' });

      // Approved plan → the SAME turn flows into implementation. Grant fresh
      // steps so an approval on the budget's last step isn't stranded.
      if (tool === 'exit_plan' && !denied && String(observation).startsWith('PLAN APPROVED')) {
        stepLimit = step + 8;
      }

      debugLog(`chat step ${step}: ${tool}${denied ? ' (denied)' : ''} → ${truncate(observation, 120)}`);
      onEvent({ type: 'tool', tool, args, observation, denied, salvaged, preview, argText: impl?.render ? String(impl.render(args) || '').slice(0, 200) : '', model: res.model, gateway: res.gateway });
      messages.push({ role: 'assistant', content: JSON.stringify({ tool, args }) });
      messages.push({ role: 'user', content: `TOOL OBSERVATION:\n${observation}\n\nContinue with the next JSON step.` });
    }

    onEvent({
      type: 'error',
      text: modes?.plan
        ? `Turn budget reached (${stepLimit} steps) with no plan approved. Plan mode is still ON — say "continue" and I will call exit_plan with the plan.`
        : `Turn budget reached (${stepLimit} steps). I paused mid-task — say "continue" to keep going.`,
    });
    return { said: null, steps: stepLimit, error: false };
  }

  /**
   * turn() — the ledger wrapper. Diff the usage accumulators around one
   * turn → a per-task line (/stats). Records even on throw, then rethrows:
   * an account of a crashed turn is exactly what you want when debugging.
   */
  async function turn(userText, opts = {}) {
    const t0 = Date.now();
    const start = { calls: usage.calls, tokIn: usage.tokIn, tokOut: usage.tokOut };
    const gwStart = Object.fromEntries(Object.entries(usage.byGateway).map(([g, v]) => [g, { ...v }]));
    let out = null;
    try {
      out = await turnImpl(userText, opts);
      return out;
    } finally {
      const byGateway = {};
      for (const [g, v] of Object.entries(usage.byGateway)) {
        const s = gwStart[g];
        const d = { calls: v.calls - (s?.calls || 0), tokIn: v.tokIn - (s?.tokIn || 0), tokOut: v.tokOut - (s?.tokOut || 0) };
        if (d.calls > 0) byGateway[g] = d;
      }
      tasks.push({
        ts: new Date().toISOString(),
        task: truncate(String(opts?.anchor ?? userText ?? '').replace(/\s+/g, ' '), 120),
        steps: out?.steps ?? 0,
        said: out?.said ?? null,
        error: Boolean(out?.error),
        calls: usage.calls - start.calls,
        tokIn: usage.tokIn - start.tokIn,
        tokOut: usage.tokOut - start.tokOut,
        durationMs: Date.now() - t0,
        byGateway,
      });
      while (tasks.length > TASK_LOG_CAP) tasks.shift();
    }
  }

  /** Per-task usage ledger, oldest first (capped at the last 100 tasks). */
  function taskLog() {
    return tasks.map((t) => ({ ...t, byGateway: { ...t.byGateway } }));
  }

  /** Context breakdown for /context — where the window actually goes. */
  function contextBreakdown() {
    const plan = modes?.plan === true;
    const systemprompt = harness.systemprompt?.length || 0;
    const memory = harness.memory?.length || 0;
    const toolGuidance = harness.toolGuidance?.length || 0;
    const guardrails = harness.guardrails?.length || 0;
    const skillsBlock = describeSkillCatalog(skills).length;
    const map = typeof repoMap === 'function' ? repoMap() : repoMap || '';
    const repoMapLen = String(map || '').length;
    const system = buildSystemPrompt({ harness, tools, skills, planMode: plan, repoMap: map }).length;
    return {
      parts: {
        systemprompt,
        memory,
        toolGuidance,
        guardrails,
        skillsBlock,
        repoMap: repoMapLen,
        // protocol preamble + tool definitions + plan-protocol/plan-mode
        // sections — measured as one remainder so the sum is always exact.
        toolsAndProtocol: system - systemprompt - memory - toolGuidance - guardrails - skillsBlock - repoMapLen,
      },
      system,
      conversation: historyChars(),
      budget: charBudget,
      autoAt: Math.round(charBudget * AUTO_COMPACT_AT),
      turns: messages.length,
      planMode: plan,
    };
  }

  return {
    turn,
    compactNow,
    get messages() { return messages; },
    get compactCount() { return compactCount; },
    get alwaysApproved() { return [...alwaysApproved]; },
    get effort() { return effortRef; },
    get streaming() { return streamingRef; },
    historyChars,
    contextBreakdown,
    taskLog,
    usage() {
      return { ...usage, byGateway: { ...usage.byGateway } };
    },
    resetApprovals() {
      alwaysApproved.clear();
    },
  };
}
