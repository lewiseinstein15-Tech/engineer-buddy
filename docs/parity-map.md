# Buddy vs Hermes vs OpenHands vs Claude Code — the parity map

*Written 2026-11-02 for engineer-buddy v0.65.0 (the audit that produced v0.66.0). Every external row was read from the source named in the last column on this date; nothing is from memory, nothing invented. Buddy rows name the file or command that proves them — run it.*

The ask: map buddy against **Hermes** and **OpenHands**, pull from them what buddy is missing or mis-implements, and add the error-correcting ("ECC") discipline everywhere. The honest headline after the audit: buddy is at or near feature parity on the agent core (tools, hooks, sub-agents, MCP, memory, self-improvement, approval gates, background tasks, computer use, web). The real gaps were not tool-shaped — they were **recovery-shaped**: an environment doctor that only looked at gateways and a REPL with no way to re-run a dead turn. Both ship in v0.66.0.

## 1. What the three references are

| Project | Identity (verified) | Shape |
| --- | --- | --- |
| **Hermes Agent** | `NousResearch/hermes-agent` — a persistent, self-hosted agent living on Telegram, Discord, Slack, WhatsApp, Signal and CLI from one gateway process; marketed self-improvement loop, 40+ tools, six terminal backends | Resident companion agent |
| **OpenHands** | `All-Hands-AI/OpenHands` (formerly OpenDevin) — in 2026 re-architected around an **Agent Server** (REST API for running multiple agents), the **software-agent-sdk**, an **Agent Canvas** frontend, and Docker-sandboxed run modes; agent-agnostic via the Agent-Client Protocol | Platform for hosted multi-agent work |
| **Claude Code** | Anthropic's terminal coding agent (docs at code.claude.com) — CLI/VS Code/JetBrains/desktop/web surfaces, hooks, sub-agents, MCP, CLAUDE.md memory, channels, scheduled tasks | The category-defining coding agent |

## 2. Feature matrix

✅ = present and tested in buddy · 🟡 = partial or session-only · ❌ = absent (with the judgment of whether it *should* exist in a $0 keyless terminal agent)

| Capability | Hermes | OpenHands | Claude Code | Buddy (proof) |
| --- | --- | --- | --- | --- |
| Terminal REPL: slash autocomplete, history, interrupt, streaming | ✅ TUI | — (Canvas) | ✅ | ✅ `src/terminal/repl.js` (Ctrl+C, ctrl+b detach, streaming) |
| Messaging channels (Telegram/Discord/Slack…) | ✅ 6 platforms | 🟡 Slack/GitHub/Linear triggers | ✅ Channels | 🟡 `channels` — webhook-driven push into a live session (v0.51); no chat-network bridges by design (keyless, no bot tokens) |
| Multi-agent: sub-agents with own model/limits | ✅ | ✅ Agent Server hosts many | ✅ lead + background agents | ✅ `task` tool + `src/agent/subagents.js` + `orchestrator.js` |
| Memory that deepens across sessions | ✅ agent-curated + FTS5 recall | ✅ conversation history survives | ✅ CLAUDE.md + auto memory | ✅ `.buddy/harness` + `memory` + `learn` + `experience` commands; 🟡 no FTS search over past sessions yet |
| Self-improvement loop | ✅ skills created from experience | — | 🟡 (skills authored by humans) | ✅ Harness²: `lessons.js`, `learn.js`, skills that accumulate (`/learn`, `/experience`) |
| Skills ecosystem, importable standard | ✅ agentskills.io Hub | — | ✅ | ✅ `skill` tool + `.buddy/skills/`; the standard used is Claude-Code-compatible |
| MCP client + server | ✅ client | 🟡 via ACP agents | ✅ client | ✅ `mcp` command, `src/mcphttp.js` client, `src/mcpserver.js` server (buddy can BE a server) |
| Approval gates / permissions | ✅ command approval patterns | 🟡 sandbox-first posture | ✅ permission modes | ✅ danger-tier gates (v0.64), `permissions` + audit trail, `/yolo` |
| Sandboxing | ✅ 6 terminal backends (local, Docker, SSH, Modal, Daytona, Vercel) | ✅ Docker per conversation | ✅ sandboxed bash | 🟡 `/sandbox` (network-off + restricted HOME) + `containers` tool; **no SSH/Modal/Daytona backends — deliberately: they all want accounts or keys** |
| Background tasks | — (serverless hibernation) | ✅ | ✅ background bash | ✅ `bash_bg`/`bash_output`/`kill_shell` tools + ctrl+b detached turns |
| Computer use (OS-level) | — | — | 🟡 Chrome integration | ✅ `computer` tool: screenshot/click/type/key (v0.65-1) |
| Browser as an actable surface | — | ✅ | ✅ Chrome integration | ✅ `browser` tool |
| Web search / fetch | — | — | ✅ | ✅ `web_search`, `web_fetch` |
| Git worktrees | — | — | ✅ | ✅ `worktree.js` |
| Checkpoints / time travel | ✅ /undo | — | ✅ /rewind | ✅ `time_travel`, `/rewind` |
| Scheduler / autonomy on a clock | ✅ built-in cron to any platform | ✅ Automation Server workflows | ✅ /schedule cloud tasks | ✅ `goals` (v0.49): objectives that wake on the OS clock — local-first, no cloud needed |
| Scheduled cloud tasks (run with machine off) | — | ✅ | ✅ | ❌ by design — buddy runs where it lives, $0 |
| Model breadth | ✅ 300+ via Portal/OpenRouter | ✅ any LLM profiles | ✅ | ✅ 4 keyless gateways + **ollama local** (v0.65) — no keys anywhere |
| Vision (images in chat) | — | — | ✅ | ✅ image attachments, vision-capable routing |
| Voice | ✅ memo transcription | — | ✅ dictate | ✅ `voice_transcribe`, `/dictate` |
| **Environment doctor** | ✅ `hermes doctor` — "diagnose any issues" | — | — | 🟡 was gateway-probe-only → **v0.66.0: full workspace ECC sweep (`src/doctor.js`)** |
| **Retry a dead turn** | ✅ `/retry`, `/undo` | — | — | ❌ was absent → **v0.66.0: `/retry` resubmits the last prompt verbatim** |

## 3. What was missing or wrong in buddy (the audit's findings)

1. **`doctor` could tell you the brain was alive but not that the workspace was dying.** The failure that actually strands users is one git operation: untracked local files that an incoming fast-forward would overwrite abort the pull with an error users misread (watched live in the v0.65 era: five stale drafts of already-shipped test files froze a laptop's `main` for weeks; the user's first fix attempt — `git stash` without `-u` — parked tracked edits but left the untracked blockers in place). Hermes ships `hermes doctor` for exactly this class. **Fixed:** `src/doctor.js` — a bounded, never-throwing workspace sweep run by `buddy doctor` after the gateway probe: settings/config JSON parse checks (a corrupt `buddy.config.json` is *silently ignored* by the loader — the check says so out loud), harness presence, upstream set/behind/ahead, **untracked-vs-upstream collision (FAIL, names every file, prescribes `git stash push -u`)**, dirty-tracked-vs-incoming overlap (WARN), stash pile inventory (INFO — nothing is lost, here is how to read it), and an ollama daemon probe when the gateway is enabled.
2. **No `/retry`.** A turn that dies mid-flight (brain offline, relay day) left the user re-typing a long prompt by hand. Hermes treats retry as a first-class control. **Fixed:** `/retry` resubmits the last prompt **verbatim** — the raw input, not the derived effective text, so `/report` data is not re-fetched and `/docs` attachments are not re-consumed (nothing double-applies); while busy it queues like any other message; with nothing run yet it says so honestly.
3. **No cross-session full-text search** (Hermes' FTS5 recall). Buddy has session recording (`/sessions`, `/resume`, `/export`) but no content search over past sessions. Left open deliberately: the recorder is append-only JSONL — the right move is an index built lazily in a later wave, not a rushed grep.
4. **SSH/Modal/Daytona terminal backends.** Hermes' six backends are genuinely useful for fleet work, but every one of them requires an account, a key, or an SSH trust relationship — a direct conflict with buddy's keyless, $0, runs-where-you-are contract. Docker (`containers` tool) and `/sandbox` cover the isolation need. Left out by design, revisited only behind a user-supplied config.

## 4. The ECC audit — what self-heals, and where the discipline now reaches

ECC here means: **every failure mode gets a named, bounded, non-looping recovery that says what happened and what to do next.** The audit walked every subsystem; these are the load-bearing corrections, old and new:

| Layer | Failure | The correction (bounded — no loops, ever) |
| --- | --- | --- |
| Model reply | cut off at the output token limit | ask again at a CHANGED budget (2×, cap 6000) with the split-payload ladder (≤1200 chars per call) |
| Model reply | reasoning-only stall, empty content, HTTP-200 error envelope | per-model 10-minute blacklist + same-call rotation, ≤3 attempts; burned budget named in the diagnosis |
| Model reply | sloppy JSON / prose posing as a plan | two-layer salvage (sloppy-JSON repair, plan-mode prose route-in); a reply starting `{` is never salvaged |
| Context | history overflows the routed model's window | `isContextOverflow` fingerprints every relay's prose → compact hard → **one** retry per turn (v0.65) |
| Gateway | rate-limit / dead / slow | circuit breaker, Retry-After parking, EMA latency routing, round-trips bounded at 2; 429/402 never blacklisted |
| Total outage | every gateway down | ollama probed once and engaged (when not explicitly enabled); else honest bounded death |
| Terminal | repaint flicker | one-write renderer; unchanged frames cost zero bytes (v0.64) |
| Tool names | muscle memory (`fs_edit`) | alias ships instead of an error round-trip (v0.65) |
| Big files | 30k char read cap | `fs_read` line paging with MORE-LINES continuation (v0.65) |
| **Workspace** | **pull blocked by untracked collisions; corrupt configs; stash amnesia** | **`buddy doctor` workspace sweep — every warn/fail names its fix (v0.66.0)** |
| **Turn** | **died mid-flight, prompt unsalvageable by hand** | **`/retry` — verbatim resubmission, queue-safe (v0.66.0)** |
| Hooks | a hook script hangs or crashes | 10s timeout per hook; PreToolUse can stop a tool, a blocked compaction degrades to skip |
| Renderer/CLI | bad flags, junk parseArgs input | teaching refusal, never a Node stack (v0.64.1) |

## 5. Sources (all opened 2026-11-02)

- Hermes Agent README — `https://github.com/NousResearch/hermes-agent`
- OpenHands README (Agent Server / Canvas / SDK architecture) — `https://raw.githubusercontent.com/All-Hands-AI/OpenHands/main/README.md`
- Claude Code overview — `https://code.claude.com/docs/en/overview`
- Buddy's own columns: `grep -rhn "name: '" src/tools/*.js`, `src/terminal/repl.js` SLASH_COMMANDS, and the test suite (`node --test`).
