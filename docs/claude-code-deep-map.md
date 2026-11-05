# Claude Code deep map — mechanisms, evidence, and what superbuddy should steal

*Written 2026-11-03. Companion to `openhands-deep-map.md`, `buddy-deep-map.md`, `dsh-deep-map.md`, `hermes-deep-map.md`. Claude Code is CLOSED-SOURCE: unlike OpenHands, there is no source tree to pin to a commit. This map is therefore grounded exclusively in five sources fetched on 2026-11-03: (a) official docs at code.claude.com — the hooks, sub-agents, and checkpointing pages; (b) the public changelog in `anthropics/claude-code@main` (9,890 lines, current at **2.1.317**, downloaded via the npm-project repo — version numbers cited below are verifiable there); (c) Anthropic's engineering post on their multi-agent research system; (d) the npm distribution `@anthropic-ai/claude-code` 2.1.317 (README only — the shipped bundle is minified and was deliberately NOT used as evidence); (e) the local `parity-map.md` in this directory. Claims not traceable to these are marked *general knowledge* and are never load-bearing. The engineering post on the Claude Agent SDK and the docs overview page timed out during fetching and are NOT cited. All statements in English per the operator's standing instruction.*

## The ask

Map Claude Code's mechanisms with verifiable evidence under the closed-source constraint, extract the design lessons that survive that constraint, and end with a ranked adoption list for superbuddy — the same discipline the OpenHands map followed.

## What Claude Code is

Anthropic's terminal-first coding agent, and the category's reference design (the parity map's words: "the category-defining coding agent"). The changelog shows its arc: 0.2.x origins (MCP present by 0.2.31, automatic conversation compaction at 0.2.47, CLAUDE.md `@path` imports at 0.2.107), a long 1.0.x line (hooks released at 1.0.38, statusline 1.0.71, output styles 1.0.81), and the current 2.x line (conversation checkpoints `/rewind` at 2.0.0, plugin system 2.0.12, Agent Skills 2.0.20, BashTool sandbox 2.0.24, agent-teams research preview 2.1.32). GA at 1.0.0 in May 2025 is *general knowledge* — the changelog carries version numbers, not dates. Surfaces beyond the CLI (VS Code, JetBrains, desktop, web, the Agent SDK powering `claude -p`) are from the parity map and docs cross-references, not from a fetched overview page.

## Mechanism inventory (each anchored to evidence)

| Mechanism | Evidence | What it does | Key constraints worth copying |
|---|---|---|---|
| **The agent loop + tool set** | *general knowledge* + doc cross-mentions | One LLM loop over typed tools (Bash, Read, Edit, Write, Agent, WebFetch/WebSearch, Task tools); permission-rule syntax (`Bash(git *)`, `Edit(*.ts)`) is the lingua franca across hooks, permissions, and subagent `if` fields | One rule grammar reused everywhere — superbuddy's admission policies should use one grammar too |
| **CLAUDE.md memory** | changelog 0.2.107 (imports); sub-agents doc (hierarchy inherited by subagents; built-ins may omit) | Repo-rooted markdown constitution, layered user → project → local → managed; `@path/to/file` imports load more files at launch | Memory-as-diffable-markdown-in-repo; superbuddy's AGENTS.md is the same idea |
| **Permissions / IAM** | hooks doc (`permission_mode` in hook input, `PermissionRequest`/`PermissionDenied` events); changelog 2.1.72 (bash auto-approval allowlist expansion), 2.1.317 ("auto mode" checks) | settings.json layering with merge semantics; allow/deny/ask per tool rule; managed policy settings that lower levels cannot disable | Every level merges rather than replaces; managed settings can't be overridden downward |
| **Hooks** | changelog 1.0.38 "Released hooks"; hooks doc (fetched) | User-defined shell/HTTP/MCP/LLM/subagent handlers at ~30 lifecycle events: `SessionStart/End`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `SubagentStart/Stop`, `PreCompact/PostCompact`, `TaskCompleted`, … | **Exit 2 = block** ("if your hook is meant to enforce a policy, use exit 2"); exit 0 + JSON = structured control (`permissionDecision: allow/deny/ask`, `updatedInput` rewrite, `additionalContext` ≤10k chars); matchers are regex with `mcp__<server>__<tool>` naming; per-event timeouts (600s default, 30s prompt, 1.5s SessionEnd); >12 prompt/agent handlers run 12 at a time; background stdout capture from a hook is refused as a "suspect capture" |
| **Subagents** | sub-agents doc (fetched) | Markdown + YAML definitions in 5 scopes; fresh context window per spawn (no history, no read files); model resolution: per-call → definition → env → inherit; background by default with later-turn completion notifications; partial runs resumable via SendMessage | Hard caps: 20 concurrent (env-tunable), 3 nesting layers; **report sanitization** — instruction-imitating text in reports is mangled and every report arrives under a header stating its instructions carry no authority |
| **Plan mode** | changelog 1.0.33, 2.0.17 ("Haiku 4.5 automatically uses Sonnet in plan mode, and Haiku for execution"), 2.1.x (`/plan <description>`) | Read-only planning phase before execution; cheap-model planning, strong-model execution | Effort-tiered model routing as a first-class mode |
| **Checkpoints (/rewind)** | changelog 2.0.0; checkpointing doc (fetched) | Automatic snapshot "before each prompt you send that starts a turn"; restore code+conversation together or either alone; compress-forward/backward from a point with optional steering instructions | 100 most recent checkpoints per session, ~30-day retention sweep; honest limits: bash-only edits untracked, subagent edits generally unrestored, "explicitly not a substitute for Git" |
| **Compaction** | changelog 0.2.47 (auto-compaction), 1.0.48 (PreCompact hook) | Conversation auto-compacts to run indefinitely; the condensation is hookable and (via checkpoint docs) steerable | Compaction as an event in the lifecycle, not a silent internal |
| **Sandbox** | changelog 2.0.24: "Sandbox: Releasing a sandbox mode for the BashTool on Linux & Mac" | OS-level sandboxing of the Bash tool | Ships as a *mode*, not a hard requirement — the operator opts in |
| **Agent Skills** | changelog 2.0.20 "Added support for Claude Skills"; parity map (buddy's skill standard is Claude-Code-compatible) | SKILL.md folders as importable capabilities across surfaces | The de-facto standard superbuddy's `skills/` dir already follows |
| **Plugins** | changelog 2.0.12 "Plugin System Released" | Commands + agents + hooks + MCP servers as installable packages from marketplaces | Ecosystem play; bundles the hook mechanism as a distribution unit |
| **MCP** | changelog ≤0.2.31 (debug mode); hooks doc (tool naming) | Universal tool bus, tools named `mcp__<server>__<tool>` | Predates the changelog window; *general knowledge*: announced Nov 2024 |
| **Agent teams** | changelog 2.1.32 research preview ("token-intensive feature"), 2.1.33 (`TeammateIdle`, `TaskCompleted` hooks, tmux teammate sessions) | Multi-agent collaboration with named teammates | Explicitly experimental and token-hungry — Anthropic's own label |
| **Schedules / cron** | changelog 2.1.72 (`CLAUDE_CODE_DISABLE_CRON`), 2.1.317 (`/schedule` cloud tasks) | Scheduled wakeups and cloud scheduled tasks | Kill-switch env var for the whole subsystem |
| **Worktrees** | changelog 2.1.x (`EnterWorktree`/`ExitWorktree` tools) | Isolated git-worktree sessions from inside the loop | Isolation as a tool call the agent can make |

## Design lessons (the durable part)

**L1 — Deterministic control points on a probabilistic loop.** Hooks turn policy into code with exit-code semantics: the LLM never arbitrates its own guardrails; exit 2 blocks, and no model output can talk its way past that. Everything else (matchers, timeouts, the "suspect capture" refusal) serves that one invariant.

**L2 — Context isolation is the scaling unit.** Subagents exist for compression: each works in its own window and returns condensed findings ("subagents act as intelligent filters"). The multi-agent post quantifies it: agents use ~4× more tokens than chat, multi-agent systems ~15×; token usage alone explained 80% of performance variance on their BrowseComp analysis; the multi-agent setup beat single-agent Opus by 90.2% — but mainly on breadth-first, parallelizable queries.

**L3 — Parallelism is scheduled, not emergent.** "The lead agent spins up 3-5 subagents in parallel rather than serially," subagents "use 3+ tools in parallel"; these changes cut research time by up to 90%. Effort budgets live in the briefs: "Simple fact-finding requires just 1 agent with 3-10 tool calls"; comparisons "2-4 subagents with 10-15 calls each" — added precisely because early versions "spawn[ed] 50 subagents for simple queries."

**L4 — Reports are untrusted input.** Two complementary defenses: sanitization at the boundary (instruction-imitating report text mangled, no-authority header prepended), and the anti-"game of telephone" pattern — subagents write full artifacts to the filesystem and "pass lightweight references back to the coordinator" instead of relaying content through conversation.

**L5 — State is files; memory is markdown.** CLAUDE.md, SKILL.md, agent definitions, settings — the entire configuration surface is diffable text that lives in repositories and merges across scopes. The durable state of a session is a transcript directory, not a database.

**L6 — Layered distrust of the model's own writes.** Checkpoints before every turn, a sandbox around Bash, permission prompts by default, hooks that can veto any tool call, and an honest doc listing what rewind does NOT capture. Each layer independently escapable by the human; none trusts the previous one.

**L7 — Escape hatches everywhere.** Every automation has a manual twin: `/rewind` menu, `/plan`, permission "ask", `CLAUDE_CODE_DISABLE_CRON`, `disableAllHooks` (except managed). The human is always one keystroke from the loop.

## Superbuddy adoption verdicts (ranked)

**Adopt now** (small, concrete, high-leverage; each maps to an existing module):

1. **Worker-report sanitization** — scrub instruction-imitating patterns from worker result summaries and prepend a "no authority" header before the engineer/brain reads them. This is defense-in-depth for superbuddy's P0-2 (sandboxed workers): a contained worker's *output* is still an untrusted channel. Target: `src/workers.js` + `src/resolver.js`; ~30 lines; test: a worker echoing `ignore previous instructions` in a result must not influence the next brain turn.
2. **Effort-budgeted delegation briefs** — every engineer→worker brief must carry objective, output format, tool guidance, task boundaries, and an effort cap (tool calls / time), recorded in the event stream. Target: `src/resolver.js`; enforcement in `src/engine.js`.
3. **Hook points generalizing the firewall** — `PreToolUse`/`PostToolUse`-style deterministic gates around worker tool execution with exit-2-blocks semantics, config merged from `.superbuddy/settings.json` levels; the existing control-plane firewall becomes a built-in hook rather than hard-coded policy. Target: new `src/hooks.js` wired into `src/workers.js` and `src/firewall.js`.
4. **Artifacts by reference** — worker outputs above a size threshold are written to `.superbuddy/artifacts/<ticket>/` and receipts carry paths, never blobs (the anti-game-of-telephone pattern, applied to the outbox). Target: `src/outbox.js` + `src/workers.js`.

**Adapt** (right idea, superbuddy-sized):

5. **Microcompact before condense** — drop aged tool outputs (keep verdict lines) before the head+tail condensation in the condenser; cheaper and lossless for decisions. Target: `src/condenser.js`.
6. **Settings layering with merge semantics** — managed/project/local config levels for admission policy and hooks, merging rather than replacing, with the same refuse-unknown-newer discipline the DB already has. Target: `src/config.js` + `src/admission.js`.
7. **Checkpoint restore granularity** — superbuddy checkpoints snapshot DB + event offsets; add code-state vs event-state split restore from the same snapshot, mirroring the checkpointing doc. Target: `src/checkpoints.js`.
8. **Effort-tiered brain routing** — plan with the strong gateway, execute with the cheap one (the 2.0.17 SonnetPlan analogue) behind the existing failover chain. Target: `src/brain.js`.

**Reject** (with reasons, so the next agent doesn't relitigate):

- **Agent teams (2.1.32)** — token-intensive by Anthropic's own changelog wording; WorkerSlots + receipts already give supervised parallelism with far less token fan-out.
- **Plugins/marketplaces (2.0.12)** — an ecosystem play; superbuddy is zero-dependency by design, and its skills directory already speaks the compatible standard.
- **Output styles / statusline / tmux surfaces** — superbuddy's surface is the admin panel and CLI, not a TUI.
- **Cloud schedules** — superbuddy's scheduling is local-by-design; a hosted cron is a different product.

## What superbuddy already has that Claude Code does not (parity check)

Claude Code has no persisted cross-restart work queue with admission gating — its resume and cron are per-conversation conveniences, not a multi-tenant durable queue. No store-then-execute delivery ledger with settle statuses. No tamper-evident authority (mandates) — its process memory is trusted outright. No versioned store migrations with pre-upgrade backups — its durable format is opaque. And no keyless floor: Claude Code requires Anthropic auth, while superbuddy's mock gateway keeps it runnable at $0. These four gaps are exactly the dsh prototype's blueprint, and the maps' standing verdict holds: hosted autonomy is what Claude Code-the-CLI does not even attempt, and what superbuddy is for.

## Verdict

The OpenHands map contributed the event spine; the buddy map contributed the ops skeleton; the dsh map contributed the blueprint. Claude Code contributes the **safety grammar that binds them**: deterministic gates on a probabilistic loop, untrusted-report hygiene at every boundary, effort-budgeted delegation, and layered distrust of the model's own writes — each adoption item above is a small patch to an existing module, not new architecture.

## Sources opened (2026-11-03)

- Hooks reference — `https://code.claude.com/docs/en/hooks` (fetched; full event taxonomy, exit codes, matchers, timeouts)
- Sub-agents — `https://code.claude.com/docs/en/sub-agents` (fetched; isolation, caps, sanitization, reporting)
- Checkpointing — `https://code.claude.com/docs/en/checkpointing` (fetched; snapshot semantics, limits)
- Multi-agent research system — `https://www.anthropic.com/engineering/multi-agent-research-system` (fetched; orchestrator-worker, token economics, delegation briefs)
- Changelog — `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` (downloaded via curl, 9,890 lines, current 2.1.317; all version citations above)
- npm — `@anthropic-ai/claude-code` 2.1.317 tarball (README only; no code used as evidence)
- Local — `parity-map.md` in this directory
