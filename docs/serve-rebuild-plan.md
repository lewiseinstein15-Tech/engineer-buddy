# buddy serve — the rebuild plan (Hermes as the blueprint)

*Written 2026-11-02 for buddy v0.67.0 (`c17bfdc`). Inputs: the two committed maps — `docs/hermes-deep-map.md` (Hermes from full source at `c8f5750a`) and `docs/buddy-deep-map.md` (Buddy from local source) — plus `docs/dsh-deep-map.md` for discipline. This is the plan, not the build; every wave ends in a committed drill (the t1–t4 style), never a demo. Non-negotiable up front: **the v0.67 structures — the firewall, headless default-deny, router fast-fail, update integrity — survive the rebuild untouched.** A rebuild that trades them for capability is a regression wearing a roadmap's clothes.*

*Status 2026-11-03: **waves 0–4 are BUILT** and ship as v0.68.0 — the firewall extension, the serve daemon (lease / control socket / drain / restart guard), the delivery ledger, goals catch-up durability, and the unattended run-token allowlists — each proven by drills t5–t8 and unit tests (`test/serve.test.js`, suite 1569 green). One build-time refinement the drills forced: read-only bash could reach the serve plane (bash's risk is arg-dependent), answered with a **serve-plane floor** at the chat gate — above the rules engine, above any token (`scaffold.js servePlaneRefusal`). Waves 5–6 (session search, programmatic tool calling) remain planned.*

## 1. What is being rebuilt, and why

Three references in a row (dsh, OpenHands, Hermes) name the same gap: **a process that owns state across restarts.** Buddy's autonomy plane — channels (event-driven) and goals (clock-driven) — dies with its session; nothing durable exists between processes. Hermes proves the shape works at scale (gateway daemon + SQLite + delivery ledger + cron, all restart-safe); dsh proves the discipline shape (store-then-execute, mandates). The rebuild is **`buddy serve`**: a resident service layer that owns durable state — obligations, claims, leases, indexes — while the session stays the only brain.

Scope boundary, stated so it cannot drift: **the daemon owns files and delivery, never the brain.** Hermes' gateway hosts full sessions; buddy serve hosts none. Turns still run in session processes the daemon spawns headless (goals already spawn them) — the router, gateways, tools, and renderer are untouched. That keeps the zero-dep identity and makes every wave reversible.

## 2. Design constraints (the identity — each one kills a wave that breaks it)

1. **Zero dependencies, bare Node.** No SQLite: JSONL + byte cursors. The pattern is already proven in-repo — `telemetry.js` consumes `events.jsonl` complete-line-only, skips and counts torn lines, discards giant lines, never wedges at zero. Every serve file follows that contract.
2. **Keyless.** No bot tokens, no platform bridges (still 🚫 by design). The service surfaces are: a loopback control socket, the existing webhook channels, the OS clock, and `eventslog.js`.
3. **The firewall reaches the new plane first.** `.buddy/serve/**` is added to `AGENT_DENY_GLOBS` (`harness/scaffold.js`) in the same commit as the first daemon line — the daemon is the operator's process, and the agent may not read or write its state.
4. **Default-deny unattended.** A headless turn gets no new powers. The only approve is the operator's pre-written allowlist; Hermes' `unattended_mode: approve` is refused — it is the hole v0.67 closed.
5. **ECC discipline.** Every failure mode gets a named, bounded, non-looping recovery that says what happened and what to do next — the standing rule since the parity audit.

## 3. What maps where (Hermes mechanism → Buddy rebuild piece)

| Hermes mechanism (file) | What it does | Buddy rebuild target |
| --- | --- | --- |
| `gateway/delivery_ledger.py` — obligations | outbound sends persisted BEFORE the send; retries 3× (30s/120s); `sweep_recoverable()` re-claims rows owned by a dead process | `.buddy/serve/obligations.jsonl` + `src/serve/delivery.js` — same states, JSONL rows, bounded redelivery |
| `agent/turn_facade_lease.py` + `cron/scheduler_ownership.py` — leases & fire-claims | pid + boot-id ownership; dead-owner reclaim; no split-brain | `.buddy/serve/lease.json` + fire-claims in `.buddy/serve/cron-claims.jsonl`; a second daemon on the same dir exits EX_TEMPFAIL |
| `gateway/control_socket.py` | private unix socket + pointer file: identify/status/pause | `.buddy/serve/control.sock`; `buddy serve status/pause/resume/stop` (Windows: named pipe, day one) |
| `gateway/drain_control.py` + `restart_loop_guard.py` + EX_TEMPFAIL/EX_CONFIG | drain marker file, restart-loop breaker, supervisor-readable exit codes | drain file `.buddy/serve/.drain_request` + the same exit-code contract in `src/serve/daemon.js` |
| `hermes_cli/gateway_service.py` — service install | writes systemd unit / launchd plist with watchdog | `buddy serve install` writes a **user** unit / plist (no root, no sudoers) |
| `gateway/dead_targets.py` | chats proven `forbidden`/`not_found` stop consuming delivery budget | `.buddy/serve/dead-targets.json` — a dead webhook costs one attempt, ever |
| `cron/missed_runs.py` — catch-up ledger | N skipped slots become one `missed ×N` row, one run | the same rule in `src/goals.js` — catch-up default-on for recurring goals, one-shots get the 120s grace |
| `cron/delivery_queue.py` — at-most-once | "losing a delivery is safer than duplicating"; claimed-but-unconfirmed stays `unknown`, never retried | the outcome states of `delivery.js`: `pending → sent / failed(n) / unknown(terminal)` |
| `hermes_state_fts.py` + `session_search_tool.py` | FTS5 over transcripts; the tool's own honesty: "No LLM calls" | `.buddy/index/sessions.idx` built by cursor over `session.js` JSONL; `/sessions --search` — no LLM in the loop |
| `tools/code_execution_tool.py` + `code_kernel.py` | model-written scripts call tools via RPC: token check, allowlist ∩ session tools, 50 calls, 300s | wave 6 (optional): a Node runner behind the same numbers |

**Refused, with reasons (the 🚫 rows of the maps, restated as build-time rules):** SQLite (JSONL is the identity — a dependency-shaped hole in a zero-dep repo); the 29 platform adapters (tokens); hosted rooms and a web dashboard (terminal-first); the auxiliary model plane (one brain); the smart-approval guardian LLM (default-deny replaces it structurally); credential pooling (accounts).

## 4. The waves — each ships with a drill, and the firewall change ships first

- **Wave 0 (hours, not days): firewall extension.** `.buddy/serve/**` into `AGENT_DENY_GLOBS` + test. Nothing else in this plan may land before it — that ordering is the whole point of rebuilding after v0.67 instead of before it.
- **Wave 1 — daemon core** (`src/serve/daemon.js`, wired as `buddy serve` in `index.js`): single-writer lease (pid + boot-id + heartbeat; double-start refuses), control socket with status/pause/stop, drain file, exit codes, restart-loop guard. **Drill t5:** `kill -9` between persist and send → the obligation is redelivered exactly once; a second `buddy serve` on the same dir exits; a corrupt line in a serve file is skipped, counted, and logged.
- **Wave 2 — the delivery ledger** (`src/serve/delivery.js`): obligations for goal-completion notices, channel replies when a session dies mid-reply, and detached `bash_bg` outputs; bounded redelivery; dead-target registry; the sweep on boot. **Drill t6:** crash mid-flood → no dupes into a live webhook, no orphans after restart; a 404 webhook is attempted once, then parked forever.
- **Wave 3 — goals durability** (`src/goals.js` extension): fire-claims so two daemons can't run one goal; the catch-up ledger; per-goal last-run heartbeat. The OS clock stays the trigger of record — the daemon adds durability, not a second clock. **Drill t7:** machine off across 5 slots → one run, one `missed ×5` row; two daemons racing → one claim wins, the loser defers and logs.
- **Wave 4 — the unattended approval plane** (`permissions.js` grammar reused): per-goal allowlists written only by the operator (`buddy goals edit --allow …`), agent writes to them refuse with `DENIED_PATH`, headless default stays deny. **Drill t8:** unattended turn attempts `rm` outside the allowlist → denied, audited in `events.jsonl`, the goal continues; the agent attempts to widen its own allowlist → refused at the firewall, not at the approval gate.
- **Wave 5 — session search** (`.buddy/index/sessions.idx`, cursor-built; `/sessions --search`): incremental, crash-safe, no LLM in the loop — Hermes' own docstring is the standard to keep. **Drill t9:** 10k-line transcript, query < 50 ms; a torn tail line is never indexed; rebuild from zero works.
- **Wave 6 (optional, last) — programmatic tool calling**: model-written JS over a loopback RPC with a constant-time token check, tool allowlist, 50-call and 300s budgets. Only after t5–t9 hold, and only if the maps' context-cost argument survives contact with real usage.

## 5. Sizing and sequencing

At repo density (~300 LOC per module average): W1 ≈ 600, W2 ≈ 450, W3 ≈ 250, W4 ≈ 200, W5 ≈ 350, W6 ≈ 400 — about **2.2k LOC, ~7% of the current codebase**. Waves 0–4 are one coherent release (**v0.68.0, "the serve wave"**); 5 and 6 can ship separately without re-architecture. Each wave's drill lives in `scripts/` beside t1–t4, its unit tests in `test/`, and its release note in the commit message the way v0.66.0 and v0.67.0 did. Nothing in the plan requires a new dependency, a new process model, or a new trust decision.

## 6. Risk register (what kills the wave, said in advance)

1. **Daemon gravity** — the pull to move brain logic into the daemon. The scope boundary in §1 is the countermeasure; if a wave needs the daemon to make a decision, the wave is wrong.
2. **Exactly-once dreams** — impossible. The ledger is exactly-once (persist before send); delivery is at-most-once for unattended results (Hermes' own rule: losing beats duplicating), bounded-retry elsewhere.
3. **Split brain** — two daemons or two machines on one directory. The lease's boot-id makes the loser exit, not negotiate.
4. **Unattended burn** — cost and permission are both capped: `brain/effort.js` already routes unattended turns to cheap models; the allowlist caps what they may touch; the 60s daemon tick is the only polling that exists.
5. **Corrupt-state drift** — every serve file honors the telemetry.js cursor contract; a wave whose files can wedge the cursor at zero forever is rejected in review.
6. **Scope creep toward Hermes** — every refused item in §3 has a name; a PR that re-introduces one needs to argue with this document first.

## 7. The verdict

The dsh exercise ended by naming hosted autonomy the one big missing thing; the Hermes map found the same gap from a second direction and supplied the machinery to close it. This plan takes the machinery, keeps the discipline, and refuses the dependencies. The build order is the argument: firewall first, daemon second, delivery third — so that by the time an unattended turn can send anything anywhere, it has already been denied everything else.
