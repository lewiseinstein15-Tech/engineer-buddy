# Engineer Buddy — Roadmap Checklist

**Goal: match Claude Code feature-for-feature, then beat it — on $0/month, zero dependencies, keyless.**

How to use: tick `- [ ]` → `- [x]` as things ship. Priority order: P0 (core parity) → P1 (important) → P2 (polish) → P3 (nice-to-have). Every "impl hint" respects the zero-dep + keyless constraints.

Sources: Claude Code official docs (code.claude.com/docs), the full 18-tool system-prompt dump (Dec 2025), 33 hook events reference, best ideas from opencode / Gemini CLI / aider / Codex CLI, plus Buddy's own extended wishlist (v0.6 session, preserved verbatim categories).

**North star (Buddy's integration vision):** MCP servers are the plugin runtime. Subagents use MCP tools. Narration streams from all levels. One unified protocol.

---

## 0. Done — v0.6.0 baseline (what Buddy already has)

- [x] Keyless brain with failover chain: kilo → llm7 → pollinations → duckai (+ ollama offline fallback)
- [x] `/gateways` health probe, `/model` gateway pinning, `/cost` usage tracking
- [x] Claude Code rendering model: static + dynamic regions, single writer, wrap/CJK-aware row accounting (mini-Ink)
- [x] Bottom input box, `/` command palette, busy footer with live timer + "esc to interrupt"
- [x] Agent loop: JSON tool protocol, protocol-repair retry, per-turn tool caps
- [x] Tools: `todo, fs_list, fs_read, fs_search, fs_write, fs_replace, fs_append, bash, say`
- [x] Approval gates (yes / no / always) for risky tools + `/yolo` bypass — human-in-the-loop
- [x] Session persistence: `.buddy/sessions/*.jsonl`, `/sessions`, `/resume`, `/export`
- [x] `/compact` context summarization, `/clear`, `/new`
- [x] Harness² file surface: `.buddy/harness/` (systemprompt, guardrails, MEMORY.md, tool_guidance, skills/SKILL.md)
- [x] `/init` scaffold, `/memory`, `/experience`, `/learn` (validated self-improvement loop)
- [x] GitHub bot: `@engineer-buddy review | fix #12 | audit | notes | triage` via GitHub Action (pr-reviewer, issue-fixer, issue-triage, release-notes, dep-auditor)
- [x] `/doctor` setup checkup
- [x] Zero npm dependencies, Node ≥ 20, $0/month

---

## 1. P0 — Core agent parity (the things that make Claude Code feel like Claude Code)

- [x] **Subagents (`task` tool)** — spawn child agent loops with scoped context; return one final report. Custom agents as `.buddy/agents/*.md` (name, description, tool allowlist). Built-in `explore` (fast codebase search) + `plan` (read-only architect) types. Parallel launch (several tasks in one step). Specialized presets: `test-writer`, `refactorer`, `doc-generator`, `security-auditor`. Parent orchestrates: decompose → delegate → aggregate. Shared fs workspace + structured message bus. **Budget limits** (max tokens / max time / max file edits per subagent), **failure isolation** (subagent crash never kills the parent), **recursive delegation with depth limit**. *Impl: reuse the existing chat loop with a fresh message array + tool subset.* **✅ shipped v0.8.0** — `task` tool on the bounded ReAct loop; 6 built-in presets (explore, plan, test-writer, refactorer, doc-generator, security-auditor); custom agents in `.buddy/agents/*.md` (frontmatter: name/description/tools/maxSteps, user overrides built-ins); structural depth limit (`task` never passed down); failure isolation (crash → ERROR report); per-turn dispatch budget (maxCalls 3); risky sub-tools still hit the approval gate with per-session "always"; live step narration in the TUI (`↳ agent · tool`); `/agents` command. Parallel launch + token/time budgets still open.
- [x] **MCP client (stdio)** — hand-rolled JSON-RPC 2.0; config in `.buddy/mcp.json`; `/mcp` command (list, status); discovered tools surfaced to the model as `mcp__<server>__<tool>`; capability negotiation at connect time; JSON Schema tool definitions. **✅ shipped v0.8.0** — zero-dep stdio transport (~330 lines): spawn + initialize handshake + notifications/initialized + tools/list + tools/call; id-matched concurrent requests; per-request timeouts; banner-noise tolerant; dead server degrades to ERROR observations (never crashes the loop); bridged tools are approval-gated on first use ("always" remembered per session); startup connects in parallel with init timeout, failures shown in banner + `/mcp`. Streamable HTTP / SSE transports still open.
- [x] **Skills v2 (SKILL.md open standard)** — frontmatter (`name`, `description`, `allowed-tools`, `disable-model-invocation`); model auto-triggers from the description; user invokes via `/skill-name`; supporting files next to SKILL.md; migrate the 5 hardcoded JS skills to SKILL.md; auto-discover in `.buddy/harness/skills/` + `~/.buddy/skills/`. **✅ shipped v0.9.1** — zero-dep frontmatter parser + 3-layer catalog (bundled `skills/` → `~/.buddy/skills/` → `.buddy/harness/skills/`, later shadows earlier); the `skill` tool is the model's only door to SKILL.md bodies (the harness firewall deny-globs `.buddy/harness/**`, so fs_read could never load them — v2 fixes that dead end); catalog (name + description only) injected into the system prompt with `disable-model-invocation` hidden; `allowed-tools` enforced in the chat loop for the rest of the turn (skill/say always allowed); `/skills` table + dynamic `/<skill-name>` slash commands in the palette; supporting files (.md/.txt/.json/.csv/.yaml) load via the same tool; the 5 CI skills migrated to bundled playbooks (`skills/{pr-review,fix-issue,dep-audit,triage,release-notes}/SKILL.md`) while `src/skills/*.js` stays as the CI executor; harness validator accepts v2 skills via frontmatter description (no always-on trigger needed); legacy frontmatter-less skills (commit-message) still load. Custom slash commands (`.buddy/commands/*.md`) remain a separate open item.
- [x] **Web tools** — `web_fetch` (URL → readable text, HTML→text, size cap, timeout) and `web_search` (keyless endpoint — DuckDuckGo HTML/lite or pollinations search; title+snippet results). Domain allow/deny rules in permissions. *This closes the biggest capability gap — the model itself declined web work in your live test.* **✅ shipped v0.7.0** — keyless DDG search (html→lite fallback), built-in Node 20 fetch, HTML→text conversion, SSRF guard (localhost/private/metadata blocked), timeout + char caps, 16 offline tests; live smoke test passed. Domain allow/deny rules still open.
- [x] **Background bash with output streaming** — `run_in_background` on the `bash` tool, shell registry, `bash_output` (incremental polling / streamed tails for dev servers + watch mode), `kill_shell`, `/tasks` command listing live shells. *Impl: `child_process.spawn` unref'd + ring buffer of output.*
- [x] **Plan mode** — read-only mode (todo/read/search/list only) until a plan is approved; shift+tab cycles normal → auto-accept → plan; `exit_plan` tool asks approval with the plan text; plans saved under `.buddy/plans/`. **✅ shipped v0.9.2** — `PLAN_TOOLS` allowlist (todo, fs_list/read/search, web_search/fetch, skill, exit_plan) enforced twice: the system prompt hides every non-plan tool (and hides exit_plan outside plan mode), plus a hard wall in the chat loop refuses anything else BEFORE caps burn or gates fire; `exit_plan` rides the standard risky-tool gate so the plan text renders as the approval preview, `[y]es` flips plan mode off **mid-turn** (implementation continues in the same context), `[n]o` keeps it on for refinement; approved plans persist to `.buddy/plans/<timestamp>-<slug>.md`; `/plan` toggles, `/plans` lists, shift+tab cycles normal → auto-accept → plan with a status-right mode tag. 14 offline tests (allowlist, persistence, tool, prompt swap, wall, same-turn unlock, denial keeps mode, shift+tab key). **✅ hardened v0.9.3 after the live test** — prose replies in plan mode are salvaged into the `exit_plan` gate (the gate still decides), the final step forces an `exit_plan` nudge, approval grants +8 bonus steps for same-turn implementation, plan-mode replies get a 2500-token ceiling, compaction summaries carry the plan-mode obligation; +8 tests (22 total). **✅ round 2 hardened v0.9.4** — sloppy-JSON repair layer (literal newlines/tabs inside string values recovered in ALL modes, before salvage/repair-retry), salvage refuses `{`-starting replies (broken JSON is never a plan), identical research-tool repeats get a "same arguments, same result" nudge, cap errors in plan mode point at exit_plan, compaction summaries open with a do-not-imitate guard; +10 tests (307 total). **✅ round 3 hardened v0.9.5** — task anchor pins the user's task into every compaction summary ("continue" keeps the anchor), mid-turn plan nudge at ~step 8 (final-step nudge stays as last resort), fs_search needle treated as text not a path ("/stats" no longer throws unsafe path); +4 tests (311 total). **✅ round 4 hardened v0.9.6** — shape-aware raw-quote recovery: terminal replies (say/finish/exit_plan) whose string payload contains raw `"` (kilo quoting search results) are rebuilt — raw quotes/backslashes/control chars re-escaped, existing escapes preserved; non-terminal tools never rebuilt (broken fs_write → repair retry, not silent mangled writes); +7 tests (318 total). Double-Esc rewind menu still open (see §8).
- [ ] **Checkpoints & `/rewind`** — automatic snapshot of every file the agent touches (content-addressed store under `.buddy/checkpoints/`); `/rewind` restores code / conversation / both; double-Esc opens rewind menu; rollback for multi-step edits. *Impl: store full file contents before first edit per file per turn.*
- [ ] **Hooks engine** — user-defined shell commands at lifecycle points: `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact, SessionEnd` (aliases: pre_edit / post_edit / pre_command / post_command / on_error). Matchers on tool name; exit 0 = allow, exit 2 = block (stderr fed back to the model); JSON on stdin; config in settings; `/hooks` command. *This is CC's "deterministic guarantee" layer.*
- [ ] **`glob` tool** — recursive `**` pattern file matching (pure JS), separate from content search; plus a tree-style `ls` view. *The model currently abuses fs_search for path questions.*
- [ ] **`multi_edit` + fs_replace hardening** — batch several edits to one file atomically; `replace_all` flag; uniqueness enforcement with helpful error; file-freshness check (reject edit if file changed since last read — CC's "file modified" guard).
- [ ] **Todo v2 — dependency-aware plans** — structured plan items with `blocked_by` dependencies (DAG, not a linear list), per-item notes, auto-promotion of unblocked items, todo state preserved through compaction.

## 2. P1 — Context & memory (do big things with a small context window)

- [ ] **`/context` visualization** — token budget breakdown bar: system prompt, harness files, conversation, tool defs, free space. per-gateway limit.
- [ ] **Auto-compact** — trigger compaction automatically at ~80% of the gateway's context limit; custom compact instructions; preserve todo state through compaction.
- [ ] **Real token accounting** — gateway-reported usage (or chars/4 estimate) per turn; enforce per-gateway context limits in the router; surface in `/cost`.
- [ ] **Repo map (aider-style)** — zero-dep symbol extraction (regex-based for JS/TS/Python: functions, classes, exports), def→reference graph, top-N most-referenced symbols with signatures appended to system prompt. *The single biggest win for large-codebase work without tree-sitter.*
- [ ] **`@file` mentions** — typing `@` in the input box opens fuzzy file completion; selected file content attaches to the turn.
- [ ] **Image input** — paste screenshot → base64 → vision-capable gateway (pollinations vision) so Buddy can do UI work from a screenshot.
- [ ] **MEMORY.md imports** — `@path` syntax to pull other files into memory; `# note` one-line quick-append from the input line.

## 3. P1 — Extensibility (plugins, tools, the ecosystem layer)

- [ ] **Custom slash commands** — markdown files in `.buddy/commands/*.md` + `~/.buddy/commands/` become `/name`; `$ARGUMENTS`, `$1`-style substitution; frontmatter: `allowed-tools`, `description`, `argument-hint`. (CC merged these into skills — keep both paths working.)
- [ ] **User-defined tools from `.buddy/tools/`** — each tool is a folder: `tools/<name>/manifest.json` (name, description, JSON Schema args, version) + `index.js` (zero-dep ESM, loaded at startup); user tools appear in the tool registry alongside built-ins.
- [ ] **Tool versioning + deprecation policy** — manifest carries `version`; registry logs deprecation warnings to the model; v1 contract frozen early so plugins don't break.
- [ ] **Tool sandboxing** — user tools run in an isolated child process (or WASM later) with resource + fs scope; a crashing tool never kills the REPL.
- [ ] **Tool composition** — simple pipe syntax so one tool's output feeds another (model-driven chaining first; explicit composition syntax later).
- [ ] **MCP server mode** — Buddy also *exposes* its own capabilities (read repo, run tests, apply patch, todo state) as an MCP stdio server so other agents (Claude Code, opencode) can drive Buddy. *Symmetry with the MCP client; stdio only at first.*
- [ ] **Plugins** — one folder bundling skills + hooks + agents + mcp.json fragments + tools; `/plugin add <owner>/<repo>` installs from a git repo; `/plugin` list / enable / disable. *Zero-dep loader: plain files + git clone, no npm.*
- [ ] **Plugin marketplace** — a curated git repo (or GitHub topic `engineer-buddy-plugin`) listing community plugins; `/plugin browse`.
- [ ] **Language packs** — TS/Python/Go/Rust analyzer plugins (wire into the LSP/symbol tools below per language).
- [ ] **Framework packs** — React, Next.js, Django, Rails convention packs (MEMORY.md templates + guardrails + skill recipes).
- [ ] **Custom reporters** — Slack, Linear, Jira, Notion notification/report plugins (via the HTTP tool + hooks).
- [ ] **Output styles** — `/output-style` (default / explanatory / learning + custom .md file) that swaps the system-prompt wrapper.
- [ ] **Statusline customization** — `/statusline` template or script: branch, gateway, ctx %, session cost, todo count.

## 4. P1 — Code Intelligence (Buddy's extended wishlist)

- [ ] **LSP integration** — full client over stdio JSON-RPC to the repo's own language servers: go-to-definition, find-references, rename, **diagnostics after every edit** (errors feed back to the model automatically), completions for the model's context. *Zero-dep: spawn `typescript-language-server` / `pylsp` / `gopls` if present. The single highest-leverage item here — catches breakage without running the test suite.*
- [ ] **Symbol index** — persistent cross-file index of defs/references (rebuilt on fs events) powering fast navigation tools: `symbol_search`, `find_refs`, `go_to_def` without a language server. *Pairs with the repo map.*
- [ ] **Call graph / dependency analysis** — from the symbol index: callers/callees of a function, import graph, impact analysis ("what breaks if I change this?").
- [ ] **Type-aware edits** — use LSP/type info to validate edits before applying (signature mismatches, unknown symbols flagged), not just text replacement.
- [ ] **Documentation lookup** — `/docs <lib>` fetches official docs (devdocs.io / official sites) into context, cached.

## 5. P1 — Execution & Testing (Buddy's extended wishlist)

- [ ] **Test debugging suite** — run a single test (`test <file>::<name>` detection per framework), rerun only failures, structured pass/fail/skip output parsed for the model.
- [ ] **Coverage reports** — run coverage tooling if present (`c8`/`istanbul`/`pytest-cov`), summarize uncovered files into the turn report.
- [ ] **Performance profiling integration** — run profilers (`node --prof`, `py-spy`) and summarize hotspots on request.
- [ ] **Time-travel debugging / replay** — replay a session's tool calls deterministically against checkpoints (P0 checkpoints make this possible); "replay from step 7 with this one edit changed".

## 6. P2 — Version Control (Buddy's extended wishlist)

- [ ] **Full git tool suite** — dedicated `git` tool wrapping diff, log, blame, branch, merge, rebase, push, stash — parsed and summarized for the model (not raw shell soup).
- [ ] **GitHub/GitLab API tool** — PR creation, review comments, CI status checks (via `gh` CLI or REST with the user's token — never Buddy's own keys); `/ci` shows latest run status per branch.
- [ ] **Conflict resolution assistance** — on merge/rebase conflict, present both sides + base to the model, propose a resolution, apply after approval gate.

## 7. P2 — Chat Narration (Buddy's extended wishlist)

- [ ] **Streaming thought process** — render the model's reasoning/gateway deltas live as they arrive, not just the final answer. *Depends on gateway streaming support; pollinations/kilo partially stream today.*
- [ ] **Collapsible thinking blocks** — structured reasoning blocks the TUI can fold/expand (renderer already owns the frame — fold state is cheap).
- [ ] **Decision rationale per step** — log why this file / why this edit next to each tool card in the session JSONL.
- [ ] **Configurable verbosity** — `silent → summary → verbose` narration levels (`/verbosity`), stored per project.
- [ ] **Replayable narration** — replay any past session step-by-step (feeds the time-travel item above).

## 8. P2 — UX & TUI polish (feel identical to Claude Code)

- [ ] **Themes** — `/theme` dark / light / high-contrast; palette-driven renderer colors.
- [ ] **Vim mode** — `/vim`: normal/insert, hjkl, dd/yy/p on the input line.
- [ ] **Shift+Enter newline** — `/terminal-setup` helper; alt+enter / `\`+enter fallback.
- [ ] **Queued messages** — type while a turn is running; queued prompts dispatch after the turn ends (not swallowed like today).
- [ ] **Ctrl+R transcript viewer** — full-screen scrollable session history overlay.
- [ ] **Ctrl+B background turn** — detach the running turn, get the prompt back, `/tasks` re-attaches.
- [ ] **Double-Esc rewind** — opens the checkpoint/rewind menu.
- [ ] **`/diff`** — colored git diff of everything the agent changed this session, with per-file summaries.
- [ ] **Better tool cards** — collapse long outputs (expand hint), diff rendering already exists; add copy-to-clipboard affordance.
- [ ] **`/pr-comments`** — pull PR review comments locally for the bot side to act on.

## 9. P2 — Sessions, headless, observability & automation (agent as a platform)

- [ ] **`buddy -p` headless mode** — print mode (run one prompt, output, exit); stdin pipe support; `--output-format text|json|stream-json`; proper exit codes. *Unlocks CI, cron, and scripting without a TTY.*
- [ ] **`buddy -c` / resume by name** — continue most recent session in this directory; `-r <name|id>`; `/rename` named sessions.
- [ ] **`/branch` + `/fork`** — branch the conversation to try a direction and switch back; fork a session into a background copy.
- [ ] **Session export/import** — `/share` produces a self-contained single-file HTML transcript (zero-dep), optional gist upload; **import** restores a session JSONL so context can be shared between machines/teammates.
- [ ] **Permission rules engine** — `.buddy/settings.json` hierarchy (user `~/.buddy/` → project → local); `permissions.allow / deny / ask` patterns like `Bash(git:*)`, `fs_write(docs/**)`; `defaultMode`; `additionalDirectories`; `/permissions` UI reads them. *Replaces the flat yes/always gate with policy.*
- [ ] **`/add-dir`** — additional working directories for monorepos.
- [ ] **Structured logging / tracing of agent actions** — every tool call, gateway call, and decision written as structured JSON events; optional OpenTelemetry export. *Debugging a 10-agent cascade failure will thank you.*
- [ ] **Audit trail of all file/command operations** — append-only `.buddy/audit.jsonl`: who (tool), what (exact args), when, gate verdict. Exportable per task.
- [ ] **Cost/token tracking per task** — extend `/cost` with per-task and per-subagent token/token/$ breakdown (Buddy's $0 story: show the savings).
- [ ] **Auto-format after edit** — PostToolUse hook default: prettier/black/go fmt when configured.
- [ ] **Git-native commits & PRs** — generated commit messages from the diff, co-authored-by trailer, PR creation flow, `--worktree` flag to isolate an agent run in its own worktree.
- [ ] **`/code-review` + `/security-review` bundled skills** — severity-table review of the current diff; `--fix` applies findings. (Bot side already reviews PRs — bring it to the local CLI.)
- [ ] **Sandbox mode** — `/sandbox`: bash runs with network off + restricted HOME; document a docker/podman profile as the strong option.

## 10. P3 — Infrastructure & specialized domains (Buddy's extended wishlist)

- [ ] **HTTP client tool with auth** — cookies, sessions, bearer/API-key auth, retries — beyond plain web_fetch; powers the custom reporters.
- [ ] **API schema fetching** — pull OpenAPI specs / GraphQL introspection into context and generate typed client stubs.
- [ ] **Browser automation** — Playwright/Puppeteer via an MCP server (not bundled — zero-dep core stays clean); screenshots feed the image-input path.
- [ ] **Container orchestration** — docker compose up/down/logs tooling; local k8s (kind/minikube) status + deploy helpers via MCP.
- [ ] **Database tools** — query, migrate, seed, inspect schemas (sqlite/pg/mysql via the repo's own drivers; read-only by default with an approval gate for writes).
- [ ] **Cloud resource management** — AWS/GCP/Azure via the repos' own SDKs or MCP servers; `cloud` tool lists/inspects, never mutates without a gate.
- [ ] **Secrets vault integration** — read secrets from 1Password CLI / `pass` / env refs at run time; never logged, never in transcripts.
- [ ] **Mobile** — iOS/Android build/test tooling detection (xcodebuild, gradle) as a language-pack-style plugin.
- [ ] **WASM / edge runtime support** — run and test wasm/edge targets (workerd, wasmtime) as an execution backend.
- [ ] **ML model helpers** — inference/fine-tune task templates (the repo's own python env; keyless inference can lean on the brain gateways).
- [ ] **Hardware/embedded** — flash, serial monitor, JTAG wrappers as plugins for embedded workflows.

## 11. P3 — Nice-to-have

- [ ] **Notebook support** — `nb_edit` tool for `.ipynb` cells.
- [ ] **Voice input** — hold-a-key dictation via a keyless STT endpoint.
- [ ] **Telemetry export** — opt-in OTel/JSONL metrics of turns, tokens, tool counts.
- [ ] **Multi-model routing** — auto-pick gateway per step (strongest for planning, fastest for chores); `/effort low|medium|high`.
- [ ] **Cross-session lessons** — experience entries indexed and auto-recalled by topic similarity (deeper Harness² integration).
- [ ] **Windows hardening** — CI matrix on windows-latest (readline + ANSI differences), official install docs.
- [ ] **`buddy update`** — self-update from the latest git tag.
- [ ] **`/stats`** — usage dashboard: turns, tokens, gateway mix, per-project history.
- [ ] **Goals & scheduled runs** — long-running objective that wakes on a schedule (bot side can run it in GitHub Actions cron).
- [ ] **Channels** — push external events (webhook → live session message).
- [ ] **MCP auth hardening** — OAuth/mTLS for remote MCP transports; rate limits per server.

## 12. Beyond Claude Code — Buddy's unfair advantages (lean into these)

- [x] **$0 forever** — keyless brain with automatic failover; CC needs a $20+/mo subscription.
- [x] **Zero dependencies** — the whole agent is readable in an afternoon; CC is a compiled black box.
- [x] **GitHub bot included** — `@engineer-buddy` review/fix/triage on any repo, free; CC charges for the equivalent Actions integration.
- [x] **Harness² self-improvement** — `/learn` proposes validated edits to its own prompt/guardrails/memory; CC has nothing like a user-owned, versioned harness.
- [ ] **Multi-gateway A/B compare** — `/compare kilo duckai <question>`: same prompt to two gateways, diff the answers side by side.
- [ ] **Self-healing routing** — persist `/gateways` probe history; the router learns live latencies and reorders the chain.
- [ ] **Offline-first mode** — auto-detect ollama when every keyless gateway fails; Buddy keeps working on a plane.
- [ ] **Radical transparency** — `/why`: show exactly which gateway, which prompt, which tool results produced the last answer (auditable agent).
- [ ] **Unified protocol end-state** — MCP as plugin runtime, subagents on MCP tools, narration streaming from every level — the architecture Buddy sketched, shipped.
