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
import { extractJson, tryRepairJson, looksTruncatedJson, debugLog, truncate } from '../util.js';
import { describeTools } from './agent.js';
import { describeSkillCatalog } from '../skills/loader.js';
import { PLAN_TOOLS, planModePrompt } from '../tools/planmode.js';
import { evaluatePermission, matchingRule, auditTrail } from '../permissions.js';
import { estimateTokens } from '../brain/usage.js';
import { classifyStep, routeForStep } from '../brain/effort.js';

export const PROTOCOL_PREAMBLE = [
  'You are Engineer Buddy ("Buddy Code"), a software engineer working in the user\'s terminal inside this repository.',
  'Protocol: every reply must be EXACTLY ONE JSON object and nothing else:',
  '  {"tool":"<tool-name>","args":{...},"why":"..."}   to use a tool, or',
  '  {"tool":"say","message":"..."}        to speak to the user and end the turn.',
  'The "why" field (tool calls only) is ONE short sentence — why this step, why this file — shown to the user next to the tool card and kept in the session log. Keep it under 20 words. Include it on EVERY tool call by default — omit it only for purely mechanical repeats (re-reading the same file, retrying the same call). Decisions carry a why; that is the house discipline.',
  'Never output prose outside JSON. Never invent tool results. Never claim you ran a command you did not run.',
  'Keep each reply small enough to finish: a reply that hits the output token limit is cut off mid-JSON and fails. For a large file, do NOT put the whole body in one call — fs_write the first part (≤1200 characters), then fs_append the rest in follow-up calls of ≤1200 characters each.',
].join('\n');

// Decision rationale (v0.37.0): the model may ship a `why` sentence with each
// tool call — logged beside the card in the session JSONL, the event log and
// the exports. Hard-capped with a clean ellipsis: a rationale is a sentence
// for humans, not a preview that can afford `…[+N chars]` noise.
export const WHY_MAX = 240;
export function extractWhy(value) {
  const w = value && typeof value === 'object' ? value.why : undefined;
  const s = typeof w === 'string' ? w.trim() : '';
  if (!s) return undefined;
  return s.length <= WHY_MAX ? s : `${s.slice(0, WHY_MAX - 1)}…`;
}

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
  whyContract = false, // v0.46: hard-bounce why-less decision calls (opt-in; default teaches in-band — see the WHY CONTRACT block)
  routing = null, // v0.56 multi-model routing: { mode:'auto'|'off', tiers:{name:'strong'|'general'|'fast'} } — tiers are the OPERATOR's declaration (buddy.config.json); undeclared = inert
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
  // Multi-model routing (v0.56.0): the effort policy picks which gateway
  // LEADS the chain for each brain call — strongest for planning, fastest
  // for chores, the user's effort level scopes the bias, an explicit /model
  // pin is absolute. Inert without tier data: no tiers declared → every
  // routeForStep call returns the base order → no chain opt, no route fact,
  // byte-identical behavior to v0.55. mode 'off' (or junk that degraded to
  // it) is the same inertness, made explicit.
  const routingCfg = routing && typeof routing === 'object' && routing.mode !== 'off'
    ? { mode: 'auto', tiers: routing.tiers && typeof routing.tiers === 'object' ? routing.tiers : {} }
    : { mode: 'off', tiers: {} };
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

  // tokenBoost (v0.63.0): the protocol-repair ladder's second gear. A reply
  // that was cut off by the output token limit cannot be fixed by asking
  // again at the SAME budget — the model writes the same big payload and is
  // cut at the same byte. Boosted repairs ask for 2× the budget (capped at
  // 6000 — free relays vary, and max_tokens is a cap the relay may clamp, so
  // this stays a request, never a promise). Plan mode's floor applies first.
  const REPAIR_BOOST_CAP = 6000;
  async function callModel(stepCtx = null, tokenBoost = 1) {
    await maybeCompact();
    const history = [systemMsg(), ...messages];
    // Plan mode raises the ceiling: a full markdown plan inside one JSON
    // string is token-heavy, and a truncated escape = protocol violation
    // (v0.9.2 live-test lesson). Effort (v0.25.0): maxTokens follows the
    // level; plan mode's floor still wins when it is higher.
    const baseTok = effortRef.maxTokens || maxTokens;
    const floorTok = modes?.plan ? Math.max(baseTok, 2500) : baseTok;
    const maxTok = tokenBoost > 1 ? Math.min(Math.round(floorTok * tokenBoost), REPAIR_BOOST_CAP) : floorTok;
    // Multi-model routing (v0.56.0): classify THIS step (pre-call facts
    // only) and let the effort policy lead the chain. The chain opt rides
    // only when the permutation genuinely differs from the base order — a
    // no-op classification must stay byte-identical on the wire. The route
    // fact is names and classes, never message text.
    let chainOpt = {};
    if (routingCfg.mode === 'auto' && stepCtx) {
      // The whole chain build is best-effort by contract: a hostile latency
      // map, a poisoned tier table, a junk order — routing degrades to the
      // default chain, the turn never notices (the makeStepRouter guarantee,
      // mirrored at the second call site).
      try {
        const cls = classifyStep(stepCtx);
        const chain = routeForStep({
          cls,
          effort: effortRef.level,
          order: router.order,
          tiers: routingCfg.tiers,
          latency: router.latency,
          pinned: router.pinned || null,
        });
        if (chain.length === router.order.length && chain.some((n, i) => n !== router.order[i])) {
          chainOpt = { chain };
          onEvent({ type: 'route', class: cls, effort: effortRef.level, chain });
        }
      } catch {
        chainOpt = {};
      }
    }
    // Streaming thoughts (v0.28.0): when the TUI listens and the toggle is
    // on, gateways get onDelta and push raw fragments out as they arrive.
    // The reply is still assembled from the FULL text — deltas never change
    // parsing, only how alive the wait looks. One-shot/CI (no onStream) and
    // /stream off both take the untouched buffered path.
    const wantStream = Boolean(onStream) && streamingRef?.enabled !== false;
    const out = await router.chat(toWire(history), {
      maxTokens: maxTok,
      ...chainOpt,
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
    let lastToolName = null; // v0.56 routing: what the previous step executed (pre-call fact for classifyStep)
    const stepRouteCtx = (step) => ({
      index: step,
      planMode: Boolean(modes?.plan),
      lastTool: lastToolName,
      remaining: stepLimit - step + 1,
    });

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
        res = await callModel(stepRouteCtx(step));
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
      // Protocol-repair ladder (v0.2 heritage, v0.63.0 extension). Two
      // distinct failures wear the same broken-JSON mask:
      //   • a formatting sneeze (prose, sloppy strings) — one cheap ask at
      //     the same budget fixes it (the historical contract, still first);
      //   • a reply the relay CUT OFF on the output token limit (v0.62 live
      //     test: a 4.4KB fs_write payload died twice — the old ask re-sent
      //     at the SAME budget, so the model wrote the same big payload and
      //     was cut at the same byte, and the turn died with it, stalling
      //     the todo at whatever step it reached). A cut-off is NOT a
      //     formatting problem: the ask must CHANGE (split the payload,
      //     fs_write + fs_append) and the budget must RISE.
      // Diagnosis: the gateway's finish_reason='length' witness when the
      // wire reports it, else the shape heuristic (unbalanced tool-call JSON
      // that ran off the end of the input). Cost bound: at most TWO repair
      // calls per step; the second gear exists only for the truncation path
      // where the retry ask is genuinely different.
      if (!parsed.ok || typeof parsed.value !== 'object' || !parsed.value || !parsed.value.tool) {
        const judge = (r) => {
          let p = extractJson(r?.text);
          if (!p.ok || typeof p.value !== 'object' || !p.value || !p.value.tool) {
            const fixed = tryRepairJson(r?.text);
            if (fixed && fixed.tool) p = { ok: true, value: fixed };
          }
          return p;
        };
        const wireCut = (r) => r?.truncated === true || looksTruncatedJson(r?.text);
        const TRUNCATION_MSG =
          'PROTOCOL ERROR: your reply was CUT OFF by the output token limit before the JSON closed — the payload did not fit in one reply. Do NOT rewrite the same big payload. Reply again with EXACTLY ONE complete JSON object and make it fit: call the same tool with a payload of ≤1200 characters (for a large file: fs_write the first ≤1200 characters, then fs_append the rest in follow-up calls of ≤1200 characters each), or do a smaller step. No other text.';
        const GENERIC_MSG =
          'PROTOCOL ERROR: your reply was not a single JSON object with a "tool" key. Reply again with EXACTLY ONE JSON object: {"tool":"<name>","args":{...}} or {"tool":"say","message":"..."}. No other text.';
        const firstText = res.text;
        const firstCut = wireCut(res);
        debugLog(`chat step ${step}: protocol violation${firstCut ? ' (reply cut off by the token limit)' : ''}, requesting repair`);
        let pairs = 0;
        let retry;
        try {
          messages.push({ role: 'assistant', content: truncate(res.text, 700) });
          messages.push({ role: 'user', content: firstCut ? TRUNCATION_MSG : GENERIC_MSG });
          pairs = 1;
          // A diagnosed cut-off goes straight to the boosted gear: the same
          // budget already produced this exact cut once.
          retry = await callModel(stepRouteCtx(step), firstCut ? 2 : 1); // same step, same route ctx — a repair is not a new step
        } catch (e) {
          onEvent({ type: 'error', text: `brain offline: ${e.message}` });
          return { said: null, steps: step, error: true };
        }
        parsed = judge(retry);
        if (!parsed.ok || typeof parsed.value !== 'object' || !parsed.value || !parsed.value.tool) {
          // Second gear — ONLY for a reply that is itself cut off (the first
          // repair wrote another payload the relay ate). A generic sneeze
          // that survived repair A stays a single-repair failure: the
          // historical contract, and a third verbatim ask never helped.
          if (wireCut(retry)) {
            try {
              res = retry;
              messages.push({ role: 'assistant', content: truncate(res.text, 700) });
              messages.push({ role: 'user', content: TRUNCATION_MSG });
              pairs = 2;
              retry = await callModel(stepRouteCtx(step), 2);
            } catch (e) {
              onEvent({ type: 'error', text: `brain offline: ${e.message}` });
              return { said: null, steps: step, error: true };
            }
            parsed = judge(retry);
          }
        }
        if (!parsed.ok || typeof parsed.value !== 'object' || !parsed.value || !parsed.value.tool) {
          messages.splice(-2 * pairs);
          // Both raws matter for debugging: the original attempt and the
          // last retry. A diagnosed cut-off is NAMED as one — the model DID
          // format a tool call; the output budget ate it (v0.62 lesson: the
          // old message blamed formatting and taught nothing).
          onEvent({
            type: 'error',
            text: firstCut || wireCut(retry)
              ? `I could not format my own reply (protocol violation — the reply was cut off by the output token limit, even at a doubled budget; split large payloads with fs_write + fs_append or raise /effort). First: ${truncate(firstText, 140)} Retry: ${truncate(retry.text, 140)}`
              : `I could not format my own reply (protocol violation). First: ${truncate(firstText, 140)} Retry: ${truncate(retry.text, 140)}`,
          });
          return { said: null, steps: step, error: true };
        }
        res = retry;
        messages.splice(-2 * pairs); // drop the violation exchange(s), keep clean history
      }

      const { tool, args = {} } = parsed.value;
      lastToolName = tool; // v0.56 routing: the NEXT call classifies from what THIS step did

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
      let durationMs = null; // Aurora: real wall time of the run, for the dotted-leader card
      let decisionCall = false; // why contract: risky tools + todo — the plan IS decisions (v0.46)
      let whyBounced = false; // set when the loop bounced a why-less decision call
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
          // ── THE WHY CONTRACT (v0.46.0) ────────────────────────────
          // The house discipline is "decisions carry a why" — and the v0.45
          // full live benchmark caught the free-model reality: whys show up
          // on the first calls, then decay. Teaching alone lost to drift.
          // A decision-class call (risky tools + todo — the plan IS decisions)
          // without a why gets: default = an in-band NOTE riding the next
          // observation (zero extra round-trips); whyContract = ONE bounce —
          // the model must resend the SAME call carrying its why. The why is
          // always authored by the model, never fabricated; the bounce is
          // bounded (one round, adopt only the same tool back, a brain blip
          // degrades to un-bounced); the exchange never pollutes history.
          decisionCall = impl.risky === true || tool === 'todo';
          if (whyContract && decisionCall && !extractWhy(parsed.value)) {
            whyBounced = true;
            debugLog(`chat step ${step}: why-contract bounce on ${tool} — demanding the why sentence`);
            messages.push({ role: 'assistant', content: truncate(res.text, 700) });
            messages.push({ role: 'user', content: `WHY CONTRACT: every decision carries a why — your ${tool} call is missing the one-sentence "why" field. Resend the EXACT same call with a short "why" added: {"tool":"${tool}","args":{...},"why":"..."}. No other text.` });
            let retry = null;
            try { retry = await callModel(); } catch { retry = null; } // brain blip → the original call proceeds un-bounced
            if (retry) {
              let p2 = extractJson(retry.text);
              if (!p2.ok || typeof p2.value !== 'object' || !p2.value || !p2.value.tool) {
                const fixed = tryRepairJson(retry.text);
                if (fixed && fixed.tool) p2 = { ok: true, value: fixed };
              }
              // Adopt only the SAME tool back — the bounce demanded a resend,
              // not a new decision; anything else is ignored (bounded).
              if (p2.ok && p2.value && typeof p2.value === 'object' && p2.value.tool === tool) {
                parsed = p2;
                res = retry; // attribution follows the call that actually runs
              }
              messages.splice(-2); // the bounce exchange stays out of history
            }
          }
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
            const runT0 = Date.now();
            observation = denied
              ? verdict === 'deny'
                ? observation // the rules-engine refusal already says WHY (which rule)
                : 'DENIED by the user: the action did NOT run. Ask the user how to proceed or pick another approach.'
              : await impl.run(args, { signal }).catch((e) => `ERROR: ${e.message}`);
            durationMs = Date.now() - runT0;
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
      const why = extractWhy(parsed.value);
      onEvent({ type: 'tool', tool, args, observation, denied, salvaged, preview, ...(why ? { why } : {}), ...(whyBounced ? { whyBounced: true } : {}), argText: impl?.render ? String(impl.render(args) || '').slice(0, 200) : '', durationMs, model: res.model, gateway: res.gateway });
      messages.push({ role: 'assistant', content: JSON.stringify({ tool, args }) });
      const whyNote = !whyContract && !denied && decisionCall && !why
        ? '\n\nNOTE (why contract): every decision carries a why — add a one-sentence "why" field to decision calls (writes, commands, plan updates).'
        : '';
      messages.push({ role: 'user', content: `TOOL OBSERVATION:\n${observation}${whyNote}\n\nContinue with the next JSON step.` });
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
