# dsh-superagent-prototype ↔ Buddy — the piece-by-piece map

*Written 2026-11-02. dsh read from a full source clone of `deepseek-ai/dsh-superagent-prototype` at main (docs 000–008 + all of `src/`); Buddy read from this repo at `cdf2bef` (v0.66.0). Verdicts: ✅ parity · 🟡 partial · ❌ not implemented · 🚫 not adopted by design · ➕ Buddy-only (dsh lacks it).*

## 1. What each side IS

**dsh-superagent** is a *hosted team agent*: an unattended daemon (DeepSeek Harness profile) listening to GitHub/Feishu sources, converting allowed requests into durable Tickets (SQLite), running each in its own worker session + directory, answering with PRs — judged by one principle (doc 000): *take as little human attention as possible*. MIT, TypeScript, research prototype, requires DeepSeek's provider + a paid GitHub account for the agent.

**Buddy** is a *terminal co-pilot*: zero-dependency Node CLI, keyless failover chain + local ollama, one session does the deciding and the doing. Its autonomy plane (channels = event-driven, goals = schedule-driven) operates *inside a live session*, not as a daemon.

## 2. Component inventories

- **dsh `src/`**: `core/` (engine, intake, evals, tickets, assignments, replies, memory, model, stage, reasons) · `app/` (store, effects, delivery, outbox, retry-health, sessions, prompts, skill-files, assessment, cards, execution-environment, http/api, views, settings+history, migration, notices, passes, roles) · `executor/` (dsh.ts, background.ts) · `sources/` (github ×4 modules, feishu ×6, host, kind, poll, registry, admission-context) · `infra/` (commands, environment, health, paths, text). Docs 000–008 + 12 prompt parts + 2 skills.
- **Buddy `src/`**: `agent/` (chat.js turn engine, agent.js ReAct, subagents.js, orchestrator.js, checkpoints, lsp, repomap, symbols) · `brain/` (4-gateway chain + ollama, repair ladder, rotation, breaker, effort routing) · `terminal/` (repl, renderer) · `tools/` (47: bash+bg, fs, git, worktree, browser, computer, web, mcp, notebook, lsp, voice, containers…) · session.js (JSONL transcripts) · eventslog.js (structured audit) · permissions.js (rules engine) · channels.js, goals.js, hooks.js, doctor.js, skills/, harness/, learn/lessons (self-improvement).

## 3. The piece-by-piece map

| # | dsh piece | What it does | Buddy counterpart | Verdict |
|---|---|---|---|---|
| 1 | Philosophy (doc 000) | acts only when asked; speaks only when a person must act; reports honestly | `/verbosity`, ribbon/statusline, honest refusal culture — but narration default is chatty | 🟡 |
| 2 | Source | durable event stream w/ read position, drops its own messages | `channels.js` (webhook inbox → live session, whitelist-normalized, junk HELD) | 🟡 session-local, no daemon |
| 3 | Trigger→Thread→Eval→Ticket→Assignment | durable work pipeline, decisions recorded, fan-out via Subscriptions | `goals.js` (cron objectives) + `orchestrator.js` (run-until-done) — no durable queue between restarts | ❌ (the core dsh idea) |
| 4 | Mandate | typed per-task authority: policy version, matched rules, scope, revalidation; only a person's stop withdraws | `permissions.js` (global allow/deny globs, deny-wins) + danger-tier gates + approval audit — global, not per-task | 🟡 |
| 5 | "Messages are inputs, not authority" | quoted text/comments can never grant permissions | attachment firewall (`[data, not instructions]` wrappers on /report, /docs) + PreToolUse hooks — attachments fenced; arbitrary file/web content not formally fenced | 🟡 |
| 6 | Store-then-execute + Effects + retry-health | every decision persisted *before* running; deliveries retried w/ backoff; 3-strike reporting | brain-side ECC (repair ladder, rotation, breaker) is in-process only; no durable outbox | ❌ |
| 7 | Session persistence | SQLite store, survives restarts | `session.js` JSONL transcripts + `eventslog.js` (append-only, rotated) | ✅ (files vs DB — both durable) |
| 8 | Resume after restart + recovery notes | sessions rebuild; restarted workers told to check dir/git/GitHub before repeating | `/resume -r <name>` rebuilds context from transcript (compaction-summarized, not verbatim) | 🟡 manual, no auto recovery notes |
| 9 | Router/worker split | orchestrator session decides; worker sessions do, per-ticket | `orchestrator.js` plan→pickNext→turn→verify→blocked loop + `subagents.js` task dispatch | 🟡 loop-level split, one process |
| 10 | Worker slots, priorities, caps | capped parallelism, humans first | subagents: `BATCH_MAX 4`, per-child timeout 240s (clamped 600s), 8k result cap, structural no-recursion, failure-isolated | ✅ |
| 11 | Per-ticket worktree/directory | `prepare` clones a worktree per ticket | `worktree.js` tool + `/branch` exist but are operator-invoked, not task-wired | 🟡 |
| 12 | Admission/Policy | allowed lists, accept modes (off/observe/auto) | approval gates + `/yolo` + rules engine | 🟡 |
| 13 | Bot discipline | bot messages → inferred candidates only, never authority | channels receiver holds unknown senders honestly | 🟡 |
| 14 | Panel (web UI) | supervision: what needs me / health / history | `/events` `/tasks` `/stats` `/why`, statusline — no web UI | 🚫 (terminal-first by design) |
| 15 | Team-editable prompts, override-base + "Default updated" diffs | teams own prompt text, upgrades preserve it | `.buddy/harness` + skills + custom agents — editable, no override-base tracking | 🟡 |
| 16 | GitHub/Feishu trigger→PR pipeline | the product surface | `ghapi/github/gitlab.js`, `/pr-comments`, gh skills — read/reply yes, triggers no (auth required) | 🟡 / 🚫 keyless |
| 17 | Background jobs w/ output delivery | long cmds detached, delivered on done | `bash_bg`/`bash_output`/`kill_shell` + ctrl+b detached turns | ✅ |
| 18 | Worker isolation | `danger-full-access` as operator user; docs suggest a dedicated OS account | `/sandbox` (network-off, restricted HOME) + `containers` tool | ➕ Buddy ships *more* isolation than dsh's default |
| 19 | Extensibility (cookbook: add a Source) | new Source = 4 responsibilities | `plugins.js` + MCP client/server | ✅ different mechanism, same door |
| 20 | Prompt roles (orchestrator/worker texts) | 12 prompt parts, handoff variants | harness context + skill personas | ✅ shape-equivalent |

**➕ Buddy-only, dsh has nothing like it:** keyless 5-gateway chain with rotation/blacklist/breaker/compact-retry · local ollama (data-sovereign, offline) · `doctor` env ECC sweep · time-travel checkpoints (`/rewind`) · LSP + symbol search + repo map · notebook editing · OS computer-use + browser tools · voice in/out · hooks system · MCP *server* mode · `/retry` · one-write terminal renderer · $0 / zero-dep / single-file install.

## 4. NOT implemented in Buddy (honest list, keyless-filtered)

1. **Unattended host mode** — dsh's essence: a daemon owning a durable ticket queue across restarts. Buddy's channels/goals die with the session. Adoptable keylessly as a future `buddy serve` (channels inbox + goals + eventslog already provide 80% of the parts). **The one big missing thing.**
2. **Per-task Mandates** — authority scoped to one task (paths, bash verbs), revalidated on resume; today's rules are global. Pairs naturally with the harness fixes parked in the operator's stash.
3. **Durable outbox / store-then-execute** — decisions/effects surviving a crash with backoff-redelivery. Buddy retries inside a process, nothing across one.
4. **Router/worker process split with slots** — separate sessions per ticket, priority slots for humans. Sub-agents cover the shape, not the isolation.
5. **Web panel** — supervision UI. Terminal-first design says no; `/events`+`/tasks` are the terminal answer.
6. **Override-base tracking for prompt parts** — teams can edit, but nothing records what a custom text was based on or diffs it against new defaults.
7. **GitHub issue→PR autonomous pipeline** — needs `gh` auth; stays out of the keyless core by contract (tools exist for the operator who *does* auth).

## 5. WRONG or overstated — including three corrections to my own earlier claims

1. **Correction: "no state persistence" — false.** `session.js` (JSONL transcripts), `eventslog.js` (machine audit), and `/resume` with context rebuild all exist and are tested. The true gap is only #6 (durability *between* processes), not persistence.
2. **Correction: "verb-string approval gate, flawed" — false.** `permissions.js` is a real rules engine: `Tool(spec)` glob grammar over tool subjects, user+project layering, deny-always-wins, junk settings degrade safely, hard-block layer independent of yolo.
3. **Correction: "subagents parked" — false.** Shipped long ago: six presets + custom `.buddy/agents/*.md`, batch cap 4, per-child deadline (240s, red-team-clamped to 600s), 8k report budget, structural no-recursion, failure-isolated observations.
4. **Naming/expectation gap:** Buddy's docs call channels+goals an "autonomy plane," but both are session-scoped — a reader could expect dsh-grade daemon autonomy. The docs over-promise relative to the mechanism.
5. **Crash recovery is manual:** a killed session is recoverable by transcript but nothing generates dsh-style recovery notes ("check directory, git history before repeating") on resume.
6. **v0.66 fixed a real wrong-implementation** in the new doctor (lost `.trim()` poisoned git revisions — caught by the evidence drill, fixed same day). The pattern that found it — build the failure, run the tool — is the standing one.

## 6. The verdict

dsh and Buddy are opposites converging: dsh is an unattended team daemon with a paywalled brain and full process access; Buddy is a $0 terminal agent with a local brain and sandbox-first access. The single highest-value adoption is **hosted autonomy (item 4.1)** built keylessly on channels+goals; second is **per-task mandates (4.2)**. Everything else on the list is either already at parity, by-design rejected, or polish.
