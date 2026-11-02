# Buddy ↔ hermes-agent — the piece-by-piece map, from Buddy's side

*Written 2026-11-02. Every Buddy row is read from THIS repo local `main` at `c17bfdc` (v0.67.0) — the updated local, per the ask: 109 modules, ~32k LOC, no runtime dependencies. Hermes rows come from the full-source clone of `NousResearch/hermes-agent` at `c8f5750a` (the mirror of this map, run from Hermes' side, lives in `docs/hermes-deep-map.md`). Verdicts: ✅ Hermes has it too · 🟡 partial or different shape · ➕ Buddy-only (Hermes has nothing like it) · ⇄ Hermes-side (the gap is on Buddy's board — see hermes-deep-map §4) · 🚫 opposite design bet, not a gap.*

## 1. What each side IS

**Buddy** is a *terminal co-pilot*: zero-dependency Node CLI (~32k LOC), a keyless failover chain over four public gateways plus local ollama, and one session that does the deciding and the doing. v0.67.0 carries the P0 hardening: the agent cannot touch its own control plane (`AGENT_DENY_GLOBS`), an unattended turn is denied by default, a dead brain fast-fails with named park times instead of sleeping, and self-update refuses rollback or rewritten history.

**Hermes** is a *resident companion agent*: a Python daemon (~150k LOC in `agent/` alone) installed as a service, answering on ~29 messaging platforms from one gateway process with SQLite state (`~/.hermes/<profile>/state.db`), ~37 provider profiles behind accounts/keys, a second "auxiliary" model plane, and six terminal backends. Its own SECURITY.md draws the boundary at the OS.

## 2. Component inventories

- **Buddy `src/`**: `agent/` (chat.js turn engine, agent.js ReAct, subagents.js, orchestrator.js, checkpoints.js, lsp.js, symbols.js, repomap.js) · `brain/` (gateways: duckai, kilo, llm7, pollinations + ollama; router.js breaker/parking/EMA; effort.js, routing-memory.js, usage.js, sse.js) · `terminal/` (one-write renderer.js, repl.js, markdown, themes, vim, replay, rewind, toolcards) · `tools/` (38 files / 51 registered tools) · control plane: permissions.js, settings.js, harness/scaffold.js (the firewall) · autonomy: channels.js, goals.js, hooks.js · memory/self-improvement: learn.js, lessons.js, skills/ (6 built-ins + loader) · ops: doctor.js, update.js, session.js, eventslog.js, telemetry.js, plugins.js · wires: mcphttp.js (client), mcpserver.js (server), voice.js, notebook.js.
- **Hermes** (condensed; full inventory in the mirror map): `agent/` phase-pipeline turn engine + provider/auxiliary planes + learning fork · `tools/` 73 static + dynamic MCP/plugin · `gateway/` 29 platform adapters + delivery ledger + hosted rooms · `cron/` + `hermes_cli/` (~60 commands) + `tui_gateway/` + `ui-tui/` (React+Ink) + `acp_adapter/` + `pm/` + `evals/`.

## 3. The piece-by-piece map (Buddy owns the rows)

| # | Buddy piece (local proof) | What it does | Hermes counterpart | Verdict |
|---|---|---|---|---|
| 1 | Zero-dependency runtime (`package.json` has no deps; 109 files) | runs on bare Node, single-clone install, nothing to audit but itself | Python venv + node_modules + own `pm/` package manager pinning chromium/ffmpeg/cua-driver sha256s | 🚫 opposite bets: Buddy stays small enough not to need a supply chain |
| 2 | Keyless brain (`src/brain/gateways/`: duckai, kilo, llm7, pollinations + ollama) | failover chain: breaker, Retry-After parking, EMA latency routing, rotation, ≤2 round-trips; 429/402 never blacklisted; local ollama as the data-sovereign floor | ~37 provider profiles + credential pool + Nous Portal anon tier — real breadth, but keys everywhere except ollama/custom | ➕ the $0 contract; ⇄ breadth needs accounts |
| 3 | v0.67 router fast-fail (`brain/router.js`) | ALL_GATEWAYS_FAILED names both park times and points at `/retry`; no in-call sleeps | fallback chain parks the route until `reset_at` and restores the primary next turn | ✅ both bounded, neither loops; Buddy reports instead of waiting |
| 4 | Turn engine (`agent/chat.js`) | JSON-step loop → tool → observation → say, streaming tool events, `/retry` verbatim resubmission (v0.66) | phase pipeline with turn leases, four stop gates, persisted tool calls, finalizer | ✅ core parity; Hermes adds LSP stop-gates and verify-on-stop |
| 5 | v0.67 self-edit firewall (`harness/scaffold.js:261` `AGENT_DENY_GLOBS`; enforced at `tools/local.js:330`, `tools/edit.js:72`) | `.buddy` control plane — settings.json, mcp.json, agents/, commands/, goals, audit, experience — is DENIED_PATH read AND write; the refusal beats any approval, so a sub-agent with auto-YES still cannot self-grant | `file_safety.py` read-denies config but **write-allows `config.yaml` on purpose** (#45947: containment belongs to the OS); instruction files ALWAYS-ask; `write_approval` staging | ➕ structural refusal vs ask-and-trust — the sharpest philosophical divergence in either map |
| 6 | Permission engine (`permissions.js` + danger tiers + `/yolo` + v0.67 headless default-deny) | glob rules over tool subjects, user+project layers, deny-wins, hard-block layer independent of yolo; unattended = deny by default, `--yolo` is the operator's finger | 10-module approval stack: unbypassable floors, import-frozen yolo, smart-guardian LLM, gateway block-wait `/approve`, `unattended_mode: approve\|deny` | 🟡 Hermes' human surfaces are richer; Buddy's unattended default is stricter than Hermes' configurable approve |
| 7 | 51 flat tools, always on (`grep "name: '" src/tools/*.js`) | no toolset gating, no deferred tools | 73 static + toolsets per surface + `tool_search` progressive disclosure | 🟡 gating earns its keep only at Hermes' surface count |
| 8 | Background execution (`bash_bg`/`bash_output`/`kill_shell`, ctrl+b detached turns) | long commands detached with output delivery | `terminal` background mode + `process_manage` + wake delivery | ✅ |
| 9 | `/sandbox` + `containers` tool | network-off, restricted HOME, containerized runs as the default posture | local backend runs as the host user (env-scrubbed); isolation delegated to docker/vendor sandboxes | ➕ sandbox-first default on a tool that ships nothing |
| 10 | Sub-agents (`agent/subagents.js` + `task` tool) | batch cap 4, per-child deadline 240s (clamp 600), 8k report budget, structural no-recursion, failure-isolated observations | `delegate_task`: ≤10 children, depth 1, credential lease per child, opt-in git-worktree isolation, summary-only reporting | ✅ Buddy caps tighter; Hermes' per-child worktrees are the one extra worth stealing |
| 11 | Orchestrator (`agent/orchestrator.js`) | plan → pickNext → turn → verify → blocked, run-until-done in one process | kanban (15 tools, durable board) + hosted rooms (durable event log) | ⇄ theirs is durable and multi-profile; Buddy's is session-scoped |
| 12 | Channels (`channels.js`) | webhook inbox → live session, whitelist-normalized, junk HELD honestly | 29 platform plugins, DM pairing codes, bot-loop breaker, delivery ledger that redelivers after a crash | ⇄ the known big gap: durable outbound delivery |
| 13 | Goals (`goals.js`) | OS-cron objectives with headless children; v0.67 makes those children default-deny | cron jobs.json + 60s ticker + SQLite at-most-once delivery + catch-up + blueprint catalog | 🟡 Buddy lacks the delivery queue and catch-up; gains structural inertness instead |
| 14 | Harness (`.buddy/harness`, skills, custom agents/commands) | editable operating context the brain loads each session | SOUL.md persona + AGENTS.md invariants + skills + `pending/` write staging | ✅ shape-equivalent |
| 15 | Self-improvement (`/learn`, `lessons.js` recall injection, `experience`) | lessons the operator chose are recalled into every future session | nudge every N turns → background fork creates/fixes skills; curator archives with rollback ledger | ⇄ Buddy learns when told; Hermes nudges itself — the prompt-shaped half Buddy lacks |
| 16 | Transcript + audit (`session.js` JSONL, `eventslog.js` append-only rotated) | `/resume` rebuilds context, `/export` carries it out; every tool call auditable | SQLite state.db + FTS5 search (no LLM in the tool, despite README) + `session_search` | ✅ durability parity; ⇄ search is on Buddy's board |
| 17 | Time travel (`agent/checkpoints.js`, `timetravel.js`, `/rewind`) | checkpoint a turn, roll the workspace back | `hermes checkpoints` | ✅ |
| 18 | Git surface (`gittool.js`, `gitwrite.js`, `worktree.js`, ghapi/github/gitlab.js, `/pr-comments`) | read/write git, worktrees, PR review loops | `worktree -w`, subagent worktrees, feishu/discord drive tools | ✅ |
| 19 | Doctor (`doctor.js`) | gateway probe + v0.66 workspace ECC sweep: untracked-vs-upstream collisions, corrupt configs named out loud, stash inventory, upstream state | `hermes doctor`, 18+ families: venv, SSL, config drift, state DB, gateway supervision, connectivity | ✅ complementary halves — Hermes checks its install, Buddy checks the workspace |
| 20 | Self-update (`update.js`, v0.67) | ancestor check refuses rollback/rewritten history (`--force` to override), verifies HEAD == tag, records the update in events.jsonl, hints the restart | git updater: commit-point tree move, sha256-pinned binaries, interrupted-pull recovery, downgrade guard, fleet receipts; no GPG | ✅ Hermes' is heavier; Buddy answers the core question — never roll back, never land on hostile history |
| 21 | MCP both directions (`mcphttp.js` client, `mcpserver.js` server) | Buddy can consume MCP servers and BE one | MCP client + `hermes_tools` server transport | ✅ rare parity — most agents only consume |
| 22 | Hooks (`hooks.js`) | PreToolUse can stop a tool, 10s per hook, blocked compaction degrades to skip | gateway hooks + `api_request_hooks` + plugin events | ✅ |
| 23 | Terminal (`terminal/` one-write renderer, toolcards, vim mode, themes) | unchanged frames cost zero bytes; everything in the process, zero UI deps | React+Ink TUI over JSON-RPC stdio, same backend serving Electron + dashboard + ACP | 🚫 terminal-first is the identity |
| 24 | Voice + computer + browser (`voice.js`, `computer.js`, `browser.js`) | voice_transcribe, /dictate; screenshot/click/type/key; scripted browser | full STT/TTS/voice chat; cua-driver desktop control; CDP browser suite with vault autofill, SSRF policy, cloud sessions | 🟡 Buddy covers the actable surface; Hermes' browser/voice are a generation deeper |
| 25 | Telemetry (`telemetry.js`, v0.53) | opt-in OTel/JSONL export of aggregated deltas from events.jsonl — default OFF means nothing runs; the endpoint is the operator's | shared_metrics: opt-in counters, local SQLite 30-day, fixed Nous endpoint | ✅ same opt-in contract — **and a correction: the mirror map's row 21 said "zero telemetry"; reading local source disproved it** |
| 26 | Odd-but-mine tools (`notebook.js` nb_read/nb_edit, `lsp.js`+`symbols.js`+`repomap.js`, `db`, `cloud`, `schema`, `secret`, `perf`) | notebook editing; symbol search and repo map feeding navigation; small sharp utilities | LSP exists (wired into stop-gates); no notebook tool, no symbol search, no repo map | ➕ notebook + symbols + repomap; Hermes' LSP-to-stop-gate wiring is the ⇄ |

## 4. Where Buddy is structurally ahead (the ➕ list, all in local v0.67.0)

1. **The firewall (row 5)** — the only design of the three mapped repos where an agent with full auto-YES approval still cannot rewrite its own privileges.
2. **Headless default-deny (row 6)** — unattended turns start from NO; Hermes starts from config.
3. **Fast-fail honesty (row 3)** — a dead brain reports its park times instead of quietly waiting.
4. **$0 keyless brain + local ollama (row 2)** — no account, no key, no network dependency to think.
5. **Sandbox-first posture (row 9)** — isolation without a container runtime.
6. **Notebook + symbol search + repo map (row 26)** — the coding-agent gaps Hermes left open.
7. **Operator-owned telemetry endpoint (row 25)** — same opt-in contract, but the destination is yours.

## 5. Where Hermes is ahead (honest list — Buddy's board, from the mirror map §4)

1. Daemon residency with a durable delivery ledger — third reference in a row to name it the one big gap.
2. FTS5 session search over the transcripts.
3. The autonomous half of the learning loop (nudge → background review → skill writes).
4. `execute_code` programmatic tool calling (zero-context-cost multi-step turns).
5. The auxiliary model plane (vision/compression/approval jobs off the main brain).
6. Proactive context compaction (Buddy compacts only on overflow).
7. Browser depth (sessions, vault autofill, SSRF policy) and voice chat.
8. Config fail-open-with-memory (Buddy's loader silently ignores corrupt config; the doctor compensates by saying so).
9. Smart-approval guardian LLM, research/evals harness, per-surface toolsets — heavier machinery than a zero-dep CLI wants today.

## 6. Corrections this reading forced (kept, in the map culture)

1. **"Zero telemetry" — false.** `src/telemetry.js` (v0.53.0, §11) is an opt-in exporter over events.jsonl; default-off never creates a dir or sends a byte. The mirror map's row 21 is fixed to ✅.
2. **Tool count drift** — 47 (v0.66 map) → **51** (v0.67); the P0 wave added hardening-era tools, not features.
3. **Gateway precision** — "4 keyless + ollama" is four files in `src/brain/gateways/` (duckai, kilo, llm7, pollinations) plus ollama.js; the ollama path is probed once when every gateway is down, never as a silent default (v0.66 ECC row).

## 7. The verdict

Read from Buddy's side, the map stops being a gap list and becomes a thesis: Buddy is small on purpose, and the v0.67 wave spent its budget on **structure** — a firewall instead of asks, default-deny instead of modes, fast-fail instead of sleeps, an ancestor check instead of trust. Hermes matches Buddy feature-for-feature nearly everywhere, exceeds it wherever accounts and daemons buy leverage, and cannot copy the structural wins without abandoning its "the OS is the boundary" stance. The adoption list stands: durable delivery, session search, the learning nudge, `execute_code` — all keyless, all next-wave-sized.
