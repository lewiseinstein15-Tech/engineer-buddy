# Engineer Buddy — Roadmap Checklist

**Goal: match Claude Code feature-for-feature, then beat it — on $0/month, zero dependencies, keyless.**

How to use: tick `- [ ]` → `- [x]` as things ship. Priority order: P0 (core parity) → P1 (important) → P2 (polish) → P3 (nice-to-have). Every "impl hint" respects the zero-dep + keyless constraints.

Sources: Claude Code official docs (code.claude.com/docs), the full 18-tool system-prompt dump (Dec 2025), 33 hook events reference, plus best ideas from opencode, Gemini CLI, aider, Codex CLI.

---

## 0. Done — v0.6.0 baseline (what Buddy already has)

- [x] Keyless brain with failover chain: kilo → llm7 → pollinations → duckai (+ ollama offline fallback)
- [x] `/gateways` health probe, `/model` gateway pinning, `/cost` usage tracking
- [x] Claude Code rendering model: static + dynamic regions, single writer, wrap/CJK-aware row accounting (mini-Ink)
- [x] Bottom input box, `/` command palette, busy footer with live timer + "esc to interrupt"
- [x] Agent loop: JSON tool protocol, protocol-repair retry, per-turn tool caps
- [x] Tools: `todo, fs_list, fs_read, fs_search, fs_write, fs_replace, fs_append, bash, say`
- [x] Approval gates (yes / no / always) for risky tools + `/yolo` bypass
- [x] Session persistence: `.buddy/sessions/*.jsonl`, `/sessions`, `/resume`, `/export`
- [x] `/compact` context summarization, `/clear`, `/new`
- [x] Harness² file surface: `.buddy/harness/` (systemprompt, guardrails, MEMORY.md, tool_guidance, skills/SKILL.md)
- [x] `/init` scaffold, `/memory`, `/experience`, `/learn` (validated self-improvement loop)
- [x] GitHub bot: `@engineer-buddy review | fix #12 | audit | notes | triage` via GitHub Action (pr-reviewer, issue-fixer, issue-triage, release-notes, dep-auditor)
- [x] `/doctor` setup checkup
- [x] Zero npm dependencies, Node ≥ 20, $0/month

---

## 1. P0 — Core agent parity (the things that make Claude Code feel like Claude Code)

- [ ] **Subagents (`task` tool)** — spawn child agent loops with their own context; return one final report. Custom agents as `.buddy/agents/*.md` (name, description, tool allowlist). Built-in `explore` (fast codebase search) + `plan` (read-only architect) agent types. Parallel launch (several tasks in one step). *Impl: reuse the existing chat loop with a fresh message array + tool subset; kill on turn end.*
- [ ] **MCP client** — hand-rolled JSON-RPC 2.0 over stdio transport (+ Streamable HTTP later); config in `.buddy/mcp.json` (local / project scopes); `/mcp` command (list, status, reconnect); discovered tools surfaced to the model as `mcp__<server>__<tool>`; server prompts become slash commands. *Impl: ~300 lines of zero-dep stdio JSON-RPC; do stdio first — most community servers support it.*
- [ ] **Skills v2 (SKILL.md open standard)** — frontmatter (`name`, `description`, `allowed-tools`, `disable-model-invocation`); model auto-triggers from the description; user invokes via `/skill-name`; supporting files next to SKILL.md; migrate the 5 hardcoded JS skills to SKILL.md; auto-discover in `.buddy/harness/skills/` + `~/.buddy/skills/`.
- [ ] **Web tools** — `web_fetch` (URL → readable text, HTML→text conversion, size cap, timeout) and `web_search` (keyless endpoint — DuckDuckGo HTML/lite or pollinations search; title+snippet results). Domain allow/deny rules in permissions. *This closes the biggest capability gap — the model itself declined web work in your live test.*
- [ ] **Background bash** — `run_in_background` on the `bash` tool, shell registry, `bash_output` (incremental polling), `kill_shell`, `/tasks` command listing live shells. *Impl: `child_process.spawn` unref'd + ring buffer of output.*
- [ ] **Plan mode** — read-only mode (todo/read/search/list only) until a plan is approved; shift+tab cycles normal → auto-accept → plan; `exit_plan` tool asks approval with the plan text; plans saved under `.buddy/plans/`.
- [ ] **Checkpoints & `/rewind`** — automatic snapshot of every file the agent touches (content-addressed store under `.buddy/checkpoints/`); `/rewind` restores code / conversation / both; double-Esc opens rewind menu. *Impl: store full file contents before first edit per file per turn — a few hundred lines total.*
- [ ] **Hooks engine** — user-defined shell commands at lifecycle points: `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact, SessionEnd`. Matchers on tool name; exit 0 = allow, exit 2 = block (stderr fed back to the model); JSON on stdin; config in settings; `/hooks` command. *This is CC's "deterministic guarantee" layer — formatters, command guards, completion gates.*
- [ ] **`glob` tool** — recursive `**` pattern file matching (pure JS), separate from content search; plus a tree-style `ls` view. *The model currently abuses fs_search for path questions.*
- [ ] **`multi_edit` + fs_replace hardening** — batch several edits to one file atomically; `replace_all` flag; uniqueness enforcement with helpful error; file-freshness check (reject edit if file changed since last read — CC's "file modified" guard).

## 2. P1 — Context & memory (do big things with a small context window)

- [ ] **`/context` visualization** — token budget breakdown bar: system prompt, harness files, conversation, tool defs, free space. per-gateway limit.
- [ ] **Auto-compact** — trigger compaction automatically at ~80% of the gateway's context limit; custom compact instructions; preserve todo state through compaction.
- [ ] **Real token accounting** — gateway-reported usage (or chars/4 estimate) per turn; enforce per-gateway context limits in the router; surface in `/cost`.
- [ ] **Repo map (aider-style)** — zero-dep symbol extraction (regex-based for JS/TS/Python: functions, classes, exports), def→reference graph, top-N most-referenced symbols with signatures appended to system prompt. *The single biggest win for large-codebase work without tree-sitter.*
- [ ] **`@file` mentions** — typing `@` in the input box opens fuzzy file completion; selected file content attaches to the turn.
- [ ] **Image input** — paste screenshot → base64 → vision-capable gateway (pollinations vision) so Buddy can do UI work from a screenshot.
- [ ] **MEMORY.md imports** — `@path` syntax to pull other files into memory; `# note` one-line quick-append from the input line.

## 3. P1 — Extensibility (plugins, commands, the ecosystem layer)

- [ ] **Custom slash commands** — markdown files in `.buddy/commands/*.md` + `~/.buddy/commands/` become `/name`; `$ARGUMENTS`, `$1`-style substitution; frontmatter: `allowed-tools`, `description`, `argument-hint`. (CC merged these into skills — keep both paths working.)
- [ ] **Plugins** — one folder bundling skills + hooks + agents + mcp.json fragments; `/plugin add <owner>/<repo>` installs from a git repo; `/plugin` list / enable / disable. *Zero-dep loader: plain files + git clone, no npm.*
- [ ] **Plugin marketplace** — a curated git repo (or GitHub topic `engineer-buddy-plugin`) listing community plugins; `/plugin browse`.
- [ ] **Output styles** — `/output-style` (default / explanatory / learning + custom .md file) that swaps the system-prompt wrapper.
- [ ] **Statusline customization** — `/statusline` template or script: branch, gateway, ctx %, session cost, todo count.

## 4. P2 — UX & TUI polish (feel identical to Claude Code)

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

## 5. P2 — Sessions, headless & automation (agent as a platform)

- [ ] **`buddy -p` headless mode** — print mode (run one prompt, output, exit); stdin pipe support; `--output-format text|json|stream-json`; proper exit codes. *Unlocks CI, cron, and scripting without a TTY.*
- [ ] **`buddy -c` / resume by name** — continue most recent session in this directory; `-r <name|id>`; `/rename` named sessions.
- [ ] **`/branch` + `/fork`** — branch the conversation to try a direction and switch back; fork a session into a background copy.
- [ ] **Share links** — `/share` produces a self-contained single-file HTML transcript (zero-dep), optional gist upload.
- [ ] **Permission rules engine** — `.buddy/settings.json` hierarchy (user `~/.buddy/` → project → local); `permissions.allow / deny / ask` patterns like `Bash(git:*)`, `fs_write(docs/**)`; `defaultMode`; `additionalDirectories`; `/permissions` UI reads them. *Replaces the flat yes/always gate with policy.*
- [ ] **`/add-dir`** — additional working directories for monorepos.
- [ ] **LSP-style diagnostics** — after each edit, run the project's own `tsc` / `eslint` / `ruff` if present and feed errors back automatically. *Zero-dep: spawn binaries the repo already has. Catches breakage without running the whole test suite.*
- [ ] **Auto-format after edit** — PostToolUse hook default: prettier/black/go fmt when configured.
- [ ] **Git-native commits & PRs** — generated commit messages from the diff, co-authored-by trailer, PR creation flow, `--worktree` flag to isolate an agent run in its own worktree.
- [ ] **`/code-review` + `/security-review` bundled skills** — severity-table review of the current diff; `--fix` applies findings. (Bot side already reviews PRs — bring it to the local CLI.)
- [ ] **Sandbox mode** — `/sandbox`: bash runs with network off + restricted HOME; document a docker/podman profile as the strong option.

## 6. P3 — Nice-to-have

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

## 7. Beyond Claude Code — Buddy's unfair advantages (lean into these)

- [x] **$0 forever** — keyless brain with automatic failover; CC needs a $20+/mo subscription.
- [x] **Zero dependencies** — the whole agent is readable in an afternoon; CC is a compiled black box.
- [x] **GitHub bot included** — `@engineer-buddy` review/fix/triage on any repo, free; CC charges for the equivalent Actions integration.
- [x] **Harness² self-improvement** — `/learn` proposes validated edits to its own prompt/guardrails/memory; CC has nothing like a user-owned, versioned harness.
- [ ] **Multi-gateway A/B compare** — `/compare kilo duckai <question>`: same prompt to two gateways, diff the answers side by side.
- [ ] **Self-healing routing** — persist `/gateways` probe history; the router learns live latencies and reorders the chain.
- [ ] **Offline-first mode** — auto-detect ollama when every keyless gateway fails; Buddy keeps working on a plane.
- [ ] **Radical transparency** — `/why`: show exactly which gateway, which prompt, which tool results produced the last answer (auditable agent).
