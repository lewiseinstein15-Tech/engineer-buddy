# Engineer Buddy 🤖🔧

**A keyless AI engineering agent. Zero API keys. Zero monthly cost.**

> **Created and built by [Lewis](https://github.com/lewiseinstein15-Tech)** — sole creator, designer & developer of Engineer Buddy.

**Buddy Code** — a Claude Code-style coding agent in your terminal (chat, explore, edit, run, verify, **search the web**) — **plus five GitHub skills** (autonomous PR review, issue → fix PR, dependency auditing, issue triage, release notes).

## Claims → proof (run it yourself)

README claims score zero unless they can be demonstrated on demand — so every
headline claim below maps to a command that demonstrates it live, with
artifacts. Run `buddy benchmark` for the whole contract at once — the full
live run currently scores **7/7 scored dimensions** (scorecard.json records
the version and the configuration it ran under).

| claim | prove it | what you'll see |
|---|---|---|
| keyless brain with failover | `buddy doctor` | per-gateway BUDDY_OK round-trips; the chain degrades honestly |
| the agent can plan, build, and verify | `buddy -p "implement SPEC.md; tests must pass"` | steps on screen; tests green on disk |
| it refuses false premises (VERIFY) | `buddy benchmark --dim verify` | a planted wrong version is caught + corrected, nothing fabricated |
| it plans before it writes (REASON) | `buddy benchmark --dim reason` | first tool call is a planner/reader; `why` on every decision — the loop BOUNCES a why-less decision call once and the model resends it carrying its own why |
| it recovers from a kill (RECOVER) | `buddy benchmark --dim recover` | SIGKILLed mid-task → checkpoint manifests prove state → finished green |
| its citations are fetchable (RESEARCH) | `buddy benchmark --dim research` | the harness fetches the cited URL ITSELF through the SSRF guard |
| one MCP protocol, every level (CAPABILITIES) | `buddy benchmark --dim capabilities` | Buddy drives Buddy: tools/list, a real read, a refused write, unknown tools are errors |
| remote MCP with auth that cannot leak (v0.48) | `node scripts/v48-drill.mjs` | a hostile server echoes the credential back in its 401 body — the client's whole output still names only the status + config; the leak probe greps every captured byte: 0 occurrences |
| frontier toolchains, machine's own, never bundled (v0.50) | `node scripts/v50-drill.mjs` | real probes across mobile/wasm-edge/ml/hardware with honest absences ("nothing fake is reported"), the refusal wall (invented serial ports, smuggled flags, traversal, coercion tricks), an ML template written + read back, and a REAL hand-encoded WASI module executing through node's WASI fallback — `exit 42` on camera |
| nothing is faked, ever | `buddy benchmark --fast` | absent capabilities SKIP **honestly with a reason** — never a fabricated pass |
| a goal wakes on a schedule and runs unattended | `buddy goal add "sweep" --cron "30 3 * * *" --prompt "..." && buddy goals run --dir .` | the tick computes what is due, locks (double-fire refused, exit 3), runs it behind the same gates, and lands an append-only history row — the clock stays external (OS cron / GH Actions cron) |
| the outside world can push into a live session (v0.51) | `node scripts/v51-drill.mjs` | a REAL loopback receiver takes token-gated webhooks into an append-only inbox (rate limits BEFORE the disk write — a flood records nothing); the refusal wall on camera (401/400/413/429, 0.0.0.0 refused with the tunnel answer, second receiver exit 3); events ride into context wrapped as "data, not instructions"; the token canary appears in ZERO captured bytes |
| it remembers every crash, by topic (v0.52) | `node scripts/v52-drill.mjs` | a flaky-race question ranks the flaky-race lesson first (idf-damped, cue×3 — NOT recency); an unrelated task recalls NOTHING and the threshold is named; a torn store counts itself and still serves the survivors; a lesson that forges the `[end experience recall]` firewall wrapper is neutralized — exactly one real close survives; every recall lands as a `lessonRecall` fact in events.jsonl |
| its metrics export opt-in, zero-dep, OTel-shaped (v0.53) | `node scripts/v53-drill.mjs` | the default config creates NOTHING (no dir, no byte, no wire — the opt-in contract proven byte-for-byte); `export --dry-run` is side-effect free; one real export lands a DELTA record and POSTs a real OTLP/HTTP-JSON payload to the bundled loopback collector — 200 on camera, the received totals match the local window exactly, and the token VALUE appears in ZERO captured bytes; `file://` and credential-embedding endpoints are refused with zero side effects |
| it edits Jupyter notebooks, by cell, with guards (v0.54) | `node scripts/v54-drill.mjs` | `nb_read`/`nb_edit` ride the same freshness guard as the fs family — an out-of-band tamper between read and edit is CAUGHT on camera (STALE_CELL, the file untouched); `replace` keeps outputs and says STALE in plain English, `clear_outputs`/`delete` drop them honestly; torn JSON, junk cells, float indices, `raw` cell types and oversized notebooks are REFUSED (exit 2, zero bytes, no tmp litter); indices are canonical-or-refused; every receipt counts cells and bytes before/after |
| it takes dictation that cannot leak (v0.55) | `node scripts/v55-drill.mjs` | recorders probed names-only (never bundled), a broken WAV is refused BEFORE any byte goes on the wire — the SERVER'S OWN counters prove zero bytes received; a hostile boundary-collision upload cannot split itself into fake parts; the transcript is data (ANSI/OSC stripped) and its text appears in ZERO event bytes |
| the effort dial routes the chain, and never lies about it (v0.56) | `node scripts/v56-drill.mjs` | two loopback mock gateways witness the arrival order on their own counters — medium: strong→strong→fast→fast→fast, high: strong Δ5 / fast Δ0 with zero new facts, low: fast Δ5 with five facts; the `/model` pin is never demoted, a junk tier is NAMED never applied, off = config order only |
| Windows is a first-class CI target (v0.57) | `node scripts/v57-drill.mjs` | a REAL child sees the POSIX HOME and a REAL child sees the Windows USERPROFILE over the same spawn wire (own-key reads — a polluted `Object.prototype.HOME` loses); every win32 absence is named on camera, doctor live; CI runs the full suite on windows-latest and a FAILED leg still beacons |
| one command runs a whole plan until done (v0.58) | `buddy run-auto "fix the failing tests"` | plan once via todo v2 → per-turn focus → operator-declared verify (`npm test`) gates every item → done or BLOCKED, honestly — the summary separates `done` (the plan's truth) from `verifiedByLoop` (the loop's own work); an existing `.buddy/todo.json` is adopted so an interrupted run resumes where it stopped; `orchestrator*` facts land in `.buddy/events.jsonl` |
| the fleet flies in formation (v0.59) | `node scripts/v59-drill.mjs` | one task call launches 4 sub-agents CONCURRENTLY over the real wire — reports land numbered in input order no matter who finishes first; one hostile child is an ERROR row while its siblings finish; a slow child returns an honest `PARTIAL: hit its time budget` (never a hang); a matching cross-session lesson rides into the child behind the `[experience recall]` firewall and the canary stays out of the events log |
| the watcher never sleeps, and never reads (v0.60) | `node scripts/v60-drill.mjs` | what moved in the workspace BETWEEN turns surfaces as a bounded data fence at the next turn start (paths + kinds, file bodies are NEVER read — the canary body stays in zero watcher bytes); the watch is PAUSED while a turn runs so the agent's own writes never echo back (the drill's mid-turn drain is 0 rows); a hostile POSIX-legal filename (newline + forged fence close + ESC) cannot forge the fence; an unwatchable root refuses with its real reason; `buddy watch --json` is the standalone CLI leg |
| evidence ships with everything (EVIDENCE) | `.buddy/benchmark/<ts>/` | scorecard.json + summary.md + per-dimension artifacts |

```
$ node src/index.js doctor

┌────────────────┬───────┬────────┬──────────────────────────────────────────┐
│ gateway        │ alive │  time  │ model / note                             │
├────────────────┼───────┼────────┼──────────────────────────────────────────┤
│ kilo           │  ✅    │   3.5s │ nvidia/nemotron-3-ultra-550b-a55b:free   │
│ llm7           │  ✅    │   0.8s │ codestral-latest round-trip OK           │
│ pollinations   │  ✅    │   0.6s │ gpt-oss-20b round-trip OK                │
│ duckai         │  ❌    │   0.1s │ best-effort (unofficial API)             │
└────────────────┴───────┴────────┴──────────────────────────────────────────┘

3/4 gateways alive. Chain never fails while ≥1 is up.
```

## Install

Buddy is zero-dependency: clone and run. There is no `npm install` step — the
whole engine is the Node.js standard library.

**Prerequisites (all platforms):** [Node.js](https://nodejs.org) **>= 20**
(`node --version` to check) and `git` on PATH. No API keys, no accounts, no
monthly cost — the brain chain is keyless by contract.

### macOS / Linux

```bash
git clone https://github.com/lewiseinstein15-Tech/engineer-buddy.git
cd engineer-buddy
node src/index.js doctor    # prove the brain chain on your machine
node src/index.js           # interactive session in this repo
npm link                    # optional: puts `buddy` on your PATH
```

### Windows 10 / 11 (official — CI-tested on windows-latest since v0.57.0)

Windows is a first-class target: the full unit suite runs on
`windows-latest` on every push, next to the ubuntu leg (see
`.github/workflows/ci.yml` — the matrix exists so readline and ANSI
differences are caught on Windows, not reported by users).

```powershell
git clone https://github.com/lewiseinstein15-Tech/engineer-buddy.git
cd engineer-buddy
node src/index.js doctor
node src/index.js
npm link   # optional: `buddy` on PATH
```

Windows notes, stated honestly:

- **Terminal:** use **Windows Terminal** or PowerShell 7. Legacy `conhost`
  consoles render ANSI colors only partially; Buddy's tables and diffs look
  their best in a modern terminal, and everything honors `NO_COLOR`.
- **Paths and state:** every project keeps its state in `.buddy/` at the repo
  root — no registry writes, no machine-global state. Spawned shells receive a
  Windows-correct environment (`USERPROFILE`-aware HOME fallback, v0.57.0).
- **Honest absences:** voice dictation (`ctrl+g`) probes for `arecord` / `sox`
  / `parecord` / `ffmpeg` capture shapes — none is a standard Windows fixture,
  so dictation reports its absence honestly there. The `unshare -rn` network
  sandbox is Linux-only and degrades to a plain, policy-guarded spawn
  everywhere else — never a fake "sandboxed" claim.
- **Shell policy is identical:** the bash tool's blocklist runs before
  anything executes, on every OS; on Windows the system shell is cmd.exe via
  Node's `shell: true` and the same allow/deny rules apply.

## Buddy Code — the terminal coding agent (v0.8)

Like Claude Code, but keyless and $0. Run it in any repo:

```bash
buddy                    # interactive session in the current directory
buddy -p "fix the flaky login test and run the suite"   # one-shot, autonomous
buddy init               # scaffold the harness (.buddy/harness/) in a repo
```

You type a task. Buddy plans it with a **todo checklist**, lists/reads/searches the code, edits files (**colored diff preview before every write**), runs tests and commands, **searches the web and reads docs** (`web_search` + `web_fetch`, keyless, SSRF-guarded), **delegates to sub-agents** (`task` tool — explore / plan / test-writer / refactorer / doc-generator / security-auditor, or your own in `.buddy/agents/*.md`), **connects MCP servers** (`.buddy/mcp.json` → tools arrive as `mcp__<server>__<tool>`), iterates until it works, and reports what changed and what it verified. The whole interface is hand-rolled ANSI — zero dependencies, zero install weight.

**The TUI is a real renderer, not a readline prompt.** v0.6 rebuilt the terminal layer on the same model Claude Code uses (Ink): the screen is split into a **static region** (replies, tool cards — printed once into scrollback, never touched again) and a **dynamic region** (the bottom input box + status footer, redrawn in place by erasing exactly the wrapped, CJK-aware screen rows the previous frame occupied). One writer owns the cursor, so the box can't ghost, duplicate or scroll away. The frame is a pure function of state: `state → buildFrame() → renderer.render()`.

**The interface, feature for feature:**

| | |
|---|---|
| rounded input box | bottom-anchored, `>` prompt, inverse block cursor, dim placeholder, live `v · gateway · ctx` status |
| `/` palette | typing `/` opens the command menu above the box — descriptions, ↑↓ select, tab accept, esc dismiss |
| busy footer | spinner · task label · `esc to interrupt · Ns` while Buddy works |
| `Ctrl+C` | interrupts the running turn **and kills the running command** (process-group kill); double-tap quits |
| `!cmd` | run a shell command yourself — trusted passthrough, policy bypassed, output inline |
| `#note` | remember something in project memory (`.buddy/harness/MEMORY.md`) |
| trailing `\` | multi-line tasks (like Claude Code's shift+enter) |
| ↑↓ | history with draft restore |
| shift+tab | cycle modes: normal → auto-accept → **plan** → normal (status shows the tag) |
| edit gates | `[y]es / [n]o / [a]lways` with a live **unified diff of exactly what will change** |

Slash commands: `/help /new /clear /compact /cost /model /gateways /permissions /todo /tools /agents /mcp /tasks /plan /plans /memory /experience /learn /review /init /export /sessions /resume /status /yolo /quit` — highlights:

- `/cost` — brain calls, **tokens in/out** (gateway-reported where the API gives it, chars÷4 estimate where it doesn't — labeled honestly), per-gateway windows, and **$0.00 spend** (keyless)
- `/model kilo` — pin a gateway first for the session; `/model auto` restores
- `/gateways` — parallel health probe of the whole keyless chain
- `/compact` — force a context summarization now (auto-compaction also runs at ~80% of the budget, see below)
- `/review [staged]` — Buddy reviews your uncommitted diff like a senior engineer
- `/agents` — the sub-agent crew: what each one can touch, and how to add your own
- `/mcp` — MCP servers + their tools (from `.buddy/mcp.json`)
- `/tasks` — live background shells (started with `bash_bg`), with output sizes and status
- `/plan` — toggle plan mode: read-only research until Buddy's plan is approved (see below)
- `/plans` — list approved plans saved under `.buddy/plans/`
- `/export` — transcript → readable markdown in `.buddy/exports/`
- `/resume <n>` — numbered session picker; sessions record tool-call tallies

### The harness is a directory you own (Harness²)

Buddy's brain is an explicit, editable harness — adapted from Google Research's **Harness²** (`google-research/harness2`, Apache-2.0, arXiv:2610.14224), the recursive agent harnessing framework. Five of its eight components live as plain markdown in `.buddy/harness/`:

```
.buddy/harness/
  systemprompt.md      c1  who Buddy is and how it works
  guardrails.md        c6a hard limits (always in effect)
  MEMORY.md            c3  durable project memory (build cmds, layout, conventions)
  tool_guidance.md     c4  how to use the tools well
  skills/<name>/SKILL.md   c6b on-demand playbooks (must be triggered to load)
```

Edit any file and the next session picks it up — that's the plug-and-play "open world" idea. Prompt-cost hierarchy (from Harness²): tool calls > skills > tool guidance > systemprompt > memory — always-on files stay tight.

### `/learn` — the Propose → Probe → Compose micro-loop

After a task, `/learn` runs the Harness² recursion adapted to free, rate-limited gateways (k=1 sequential, ~2 brain calls):

1. **Reflect** on the task transcript → one `EXPERIENCE.md` entry (`cue / lesson / evidence / confidence`). No concrete contrast in the transcript → an honest `NO_ENTRY`, never an invented lesson.
2. **Propose** at most one harness edit (systemprompt, guardrails, MEMORY, tool guidance, or a new skill). The validator enforces the surface (markdown only), size caps, the grader-marker tripwire, and Harness²'s **triggered-skills rule**; invalid proposals get one verbatim-error retry, then **KEEP_BASE** — the safe default. Every applied edit leaves a timestamped backup.

Lessons flow forward: recent lessons are injected into future sessions' project memory.

### Sub-agents — one Buddy, a whole crew (v0.8)

Buddy can delegate mid-task through the `task` tool. Each sub-agent runs on the same bounded ReAct loop with its **own context**, a **tool allowlist**, and a **step budget**, then returns one report to the main loop. Six presets ship built-in — `explore` (read-only code scout), `plan` (read-only architect), `test-writer`, `refactorer`, `doc-generator`, `security-auditor` — and you can define your own as plain markdown:

```markdown
<!-- .buddy/agents/scout.md -->
---
name: scout
description: Fast read-only code scout
tools: fs_list, fs_read, fs_search
maxSteps: 8
---
You are Scout. Find where things live. Cite file:line. Be brief.
```

Safety rails, structural not hopeful: a sub-agent **never receives the `task` tool** (no recursive spawning), a crashed sub-agent degrades to an ERROR report (the main loop keeps working), dispatch is capped per turn, and risky tools inside a sub-agent still hit your approval gate with "always" remembered for the session.

### MCP — Buddy speaks the Model Context Protocol (v0.8)

Drop a `.buddy/mcp.json` in the workspace and Buddy becomes an MCP **host**: servers connect at startup (stdio JSON-RPC 2.0, zero dependencies) and every tool they expose is registered as `mcp__<server>__<tool>` — callable like any native tool.

```json
{
  "mcpServers": {
    "fetch":  { "command": "uvx", "args": ["mcp-server-fetch"] },
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }
  }
}
```

First use of each MCP tool asks for approval (answer `a` to always-allow for the session). Timeouts are capped per request; a dead server shows up in `/mcp` and its tools return clean ERROR observations — one bad server never blocks startup or kills a turn.

**Try MCP in 60 seconds (zero installs):** the repo ships a demo server — pure Node, no dependencies, nothing to download.

```bash
# 1. create the config
mkdir -p .buddy && cat > .buddy/mcp.json <<'EOF'
{
  "mcpServers": {
    "demo": { "command": "node", "args": ["examples/echo-mcp.js"] }
  }
}
EOF

# 2. start buddy — the banner shows:  mcp: demo connected (3 tools)
buddy
```

Then inside Buddy:

```
use the mcp__demo__echo tool to say "hello", then ask mcp__demo__now for the time in Africa/Nairobi
```

`echo`, `now` (IANA timezones) and `word_count` ride the full stack: spawn → initialize handshake → `tools/list` → approval gate → `tools/call`. See `examples/echo-mcp.js` — it is also a template for writing your own servers (~150 lines, stdio JSON-RPC only).

### MCP over HTTP — remote servers with auth that cannot leak (v0.48)

A `url` entry instead of a `command` connects a REMOTE server (Streamable-HTTP-style MCP: one JSON-RPC POST per message, session ids echoed, SSE responses parsed with the same flood discipline as stdio):

```json
{
  "mcpServers": {
    "remote-demo": {
      "url": "https://mcp.example.com/mcp",
      "auth": { "type": "bearer", "tokenEnv": "MCP_REMOTE_TOKEN" }
    }
  }
}
```

The hardening rules, in order of importance:

- **Credentials live in the environment, referenced by NAME.** `tokenEnv` for bearer, `clientSecretEnv` for oauth2 client-credentials (token cached, exactly one refresh on a 401, then an honest error — no loops), and `${VAR}` references inside custom header values. A config that embeds a literal secret is **refused**; a URL that embeds credentials is **refused**; `tls.insecure` is **refused** — certificate validation cannot be disabled through config. mTLS rides `tls: { ca, cert, key }` PEM file paths.
- **A missing env var is an honest connect failure** — the placeholder is never sent, not even an unclosed one.
- **The value never renders.** `/mcp` shows `host (bearer via env NAME)`; errors name the HTTP status and where to look; response bodies are never quoted into errors — a hostile server that echoes your token back in a 401 body leaks nothing. The drill proves it on camera: `node scripts/v48-drill.mjs` (frames + leak probe in `download/aurora-evidence/v48-readable/`).
- **Per-server rate limits.** `rateLimit: { "max": 30, "perMinutes": 1 }` caps the whole server (all its tools share the budget); exhaustion is an honest in-band refusal — `rate limited … No call was made.` — never an auto-sleep. Remote servers get a default budget (120/min) so a runaway loop cannot bill anyone; local stdio servers keep the unlimited default.

Try it in 60 seconds with the repo's own remote demo (zero installs):

```bash
export MCP_HTTP_TOKEN='dev-token-123'
node examples/echo-mcp-http.js --port 8931          # add --evil-echo for the red-team mode
mkdir -p .buddy && cat > .buddy/mcp.json <<'EOF'
{ "mcpServers": { "remote-demo": { "url": "http://127.0.0.1:8931/mcp",
  "auth": { "type": "bearer", "tokenEnv": "MCP_HTTP_TOKEN" } } } }
EOF
buddy                                                # /mcp shows: 127.0.0.1:8931 (bearer via env MCP_HTTP_TOKEN)
```

### Background shells — long-running work without blocking the turn (v0.9)

Dev servers, watchers, builds — Buddy starts them with `bash_bg`, polls output with `bash_output` (tail ring buffer, per-shell cap), and stops them with `kill_shell` (whole process tree). `/tasks` shows every shell: status, runtime, output size. Same hard policy as `bash` (one simple command, no pipes/sudo/network/git-write), own process group per shell, and everything is reaped when Buddy exits.

```text
> start the dev server in the background and tell me when it's up
⏺ bash_bg npm run dev
  ⎿ OK shell #1 started (pid 4123)
⏺ bash_output {"id":1}
  ⎿ shell #1 — running (3.2s)
  ⎿ ready on http://localhost:3000
```

### Plan mode — architect first, edit after approval (v0.9.2)

Toggle with `/plan` or **shift+tab** (normal → auto-accept → plan). In plan mode Buddy gets only research tools — `fs_search`, `fs_read`, `fs_list`, `web_search`, `web_fetch`, `todo`, `skill` — and the write tools, bash, sub-agents, MCP, and background shells are refused before they can even hit a gate. When research is done, Buddy calls `exit_plan` with the full plan; the standard approval gate renders it and your `[y]es` flips plan mode off **mid-turn**, so implementation continues in the same context — nothing lost, nothing restarted. Approved plans are saved to `.buddy/plans/` (`/plans` lists them); a `[n]o` keeps plan mode on so Buddy refines the plan instead.

Live-testing hardening (v0.9.3): small free models sometimes write the plan as **plain prose** instead of a JSON tool call (escaping a long markdown plan into one JSON string is exactly what they fail at). In plan mode that prose is now **salvaged** — it routes straight into the `exit_plan` gate, so you still see it and approve or deny; normal turns keep the strict repair path. The last step of a turn gets a *"call exit_plan NOW"* nudge, an approval grants **8 bonus steps** so implementation never lands on a spent budget, plan-mode replies get a raised token ceiling (2500) so long plan JSON isn't truncated mid-escape, and compaction summaries carry the plan-mode obligation forward.

Second live-test round (v0.9.4): kilo then emitted a `say`-JSON with **literal newlines inside the string** (invalid JSON) — the salvage wrapped that junk as a "plan" and an approval flipped plan mode off on garbage. Now a **sloppy-JSON repair layer** (all modes) escapes control characters inside string values before anything else, so the reply means what the model intended; the salvage **refuses `{`-starting replies** (broken JSON is never a plan); identical `fs_search`/`fs_read`/`fs_list`/`web_*` repeats get a *"same arguments, same result"* nudge instead of silently returning the same output (kilo burned its own 6/6 search cap re-running one query); the cap error in plan mode points at `exit_plan`; and compaction summaries open with *"Do not repeat it, do not imitate its format"* so small models stop imitating the summary format.

Third round (v0.9.5) — beating research drift: kilo could still lose the plot on long plan-mode research (seven compactions in one turn dissolved the task, and it planned the wrong thing). Now the **task anchor** pins the user's task into every compaction summary (`CURRENT TASK: …` — short follow-ups like "continue" keep the previous anchor), a **mid-turn nudge at ~step 8** tells Buddy to stop researching and call `exit_plan` (the final-step nudge remains as the last resort), and `fs_search` treats its needle as **text, not a path** — searching `"/stats"` no longer throws `unsafe path`.

Fourth round (v0.9.6) — raw-quote recovery: with the needle fixed, kilo's next live reply quoted the search results — `ERROR: unsafe path "/stats"` — leaving **raw double quotes inside the JSON string**, which derailed every parser (control-char escaping can't fix quotes) and killed the turn. A last-resort **shape-aware recovery** now rebuilds terminal replies (`say`/`finish`/`exit_plan`) whose payload contains raw quotes: it re-escapes only what is actually broken (raw quotes, raw backslashes, control chars) while preserving existing escapes. Deliberately limited to terminal tools — a broken `fs_write` still goes to the repair retry, never to a silent, mangled rebuild.

```text
/plan
⏸ plan mode ON — Buddy researches read-only, then calls exit_plan

> why is checkout failing? fix it
⏺ fs_search "charge()"
⏺ fs_read src/payments/stripe.js
⏺ exit_plan split the currency check
  ⎿ ## Plan — 1. add currency guard in charge() …
  ⚠ approve [y/n/a] > y
  ✓ plan approved — exited plan mode · saved to .buddy/plans/
⏺ fs_replace src/payments/stripe.js …
```

### Checkpoints & /rewind — undo what Buddy touched (v0.9.7)

Kilo's v0.9.6 session ended the hard way: a half-applied `fs_replace` left `src/tools/local.js` broken, and the brain went offline before it could recover. Now every file-mutating tool snapshots its target **before** the edit lands. Each `fs_write`, `fs_replace`, and `fs_append` stores the pre-edit content in a content-addressed store — `.buddy/checkpoints/objects/<sha256>` — plus a manifest recording which file, which tool, and whether the file existed before (so a rewind can also **delete** files the agent created). `/rewind` lists the last 10 checkpoints; `/rewind 1` restores the latest. Each restore is **one undo step**: the applied checkpoint is consumed, so repeating `/rewind 1` walks backwards through history — v0.11.2 fixed a live bug where the manifest was never consumed and every `/rewind 1` re-restored the same snapshot forever.

```text
> /rewind
#  when                 tool        files
1  2026-10-25 17:50:03  fs_replace  src/tools/local.js
2  2026-10-25 17:50:01  fs_append   src/tools/local.js
  restore: /rewind <#>  ("/rewind 1" = latest) — files only, the conversation stays

> /rewind 1
  ↩ rewound to the state before fs_replace (2026-10-25 17:50:03)
    restored src/tools/local.js
  files only — the conversation was not rewound
```

Design notes: identical content is deduped to one object (same sha256 → same blob); a per-process sequence number keeps same-millisecond snapshots in creation order; retention keeps the newest 50 manifests and prunes orphan objects; `.buddy/**` is never snapshotted; files over 2 MB are skipped; and restore refuses traversal paths even from a hand-edited manifest. Known limits (on purpose): `bash` edits are not captured — only the three file tools funnel through the snapshot hook — and the rewind restores **files only**, not the conversation. 14 tests (round-trip, dedupe, delete-on-rewind, traversal refusal, retention, chat-level end-to-end).

### Brain-offline honesty — every gateway accounted for (v0.9.8)

When the whole keyless chain fails, the `brain offline` line now reports **every gateway in the chain** — including ones skipped because their circuit breaker was already open (`llm7: circuit open (retry in ~43s)`), which previously vanished from the report entirely. And when a rate limit caused the outage, the line ends with an actionable hint: `wait ~60s for the rate limit to lift, then say "continue"` — kilo parks for its exact `Retry-After`, and now the report says so instead of leaving you guessing.

### Dependency-aware plans — todo v2 (v0.10.0)

Buddy's plan list grew up: items can now declare **dependencies** (`blocked_by`) and the DAG is enforced, not just stored. A blocked item cannot start or finish until every blocker is `done` — the tool refuses the whole update with the exact violation (`"2" (done) is blocked by "1" (in_progress)`), so a model cannot accidentally skip a step. Every reply lists the **READY NOW** items (pending, all blockers done) so the next actionable step is always visible, and unknown/duplicate/self blocker ids are caught the same way. Plans survive context compaction: the `CURRENT PLAN` (statuses included) rides next to the task anchor in every summary. Old plans still work — ids are optional and auto-assigned. 13 tests.

```text
⏺ todo · 3 items
  ✓ #1 write failing test
  ▸ #2 patch the bug · after #1
  ○ #3 run the suite · after #2
```

### The glob tool — path questions answered directly (v0.10.1)

Small models keep asking path questions with the content search. Now they have the right tool: `glob {"pattern":"src/**/*.js"}` — pure-JS, zero-dep matching with `**` globstars, `?`, `[abc]` classes and `{a,b}` braces, walking the same ignore list as `fs_list` (node_modules, .git, dot-dirs are invisible). Results are sorted, capped at 200 with a hint to narrow the pattern, and the tool is read-only — so it is allowed in plan mode too.

### multi_edit + the freshness guard — half-applied edits are over (v0.10.2)

`multi_edit` batches several exact-snippet changes to one file **atomically**: every edit is simulated first — one bad match aborts the whole batch (file byte-identical) with the precise failing edit number, and the approval preview renders the combined diff. `fs_replace` gained `replace_all` and its ambiguity error now names the matching lines. And the big one: a **file-freshness guard** — Buddy tracks what it read, and refuses to edit any file that changed outside its tools (`changed since you last read it — fs_read it again`) until it re-reads. Bash-mangled files, half-applied batches, concurrent terminals: blind re-edits just stopped.

### Hooks — rules the model cannot talk its way around (v0.11.0)

The gate is a human decision; hooks are machine law. Put shell commands in `.buddy/settings.json` and Buddy fires them at lifecycle points — `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`, `Stop`, `SessionStart`, `SessionEnd`, `OnError` (plus friendly aliases: `pre_edit`, `pre_command`, …). Each hook receives one JSON event on stdin; **exit 0 allows, exit 2 blocks** — a `PreToolUse` block stops the tool before it runs and feeds the hook's stderr straight back to the model ("BLOCKED by hook: no destructive commands"), a `UserPromptSubmit` block refuses the prompt before a single brain call is spent. Matchers limit the blast radius (`{"matcher": "bash", "command": "node check.js"}`), a 10s timeout kills runaway hooks, and broken config degrades to warnings — a bad hook can never take the agent down. Matchers are tool-name **regexes**: `{"matcher": "fs_write|fs_append"}` covers both, and the `pre_edit` alias means *every* file-mutating tool (`fs_write|fs_replace|fs_append|multi_edit`) — a live test taught this the hard way when Buddy, blocked on `fs_write`, simply routed the same write through `fs_append`. A single-tool matcher is a turnstile, not a wall. `/hooks` shows what is armed.

```json
{ "hooks": {
    "PreToolUse": { "matcher": "bash", "command": "node scripts/no-force-push.js" },
    "pre_edit":   "node scripts/require-test-first.js"
}}
```

### Queued messages — keep typing while Buddy works (v0.12.4)

Tasks used to bounce while a turn ran (`one task at a time`). Now typing queues the message (Claude Code style): the input stays live, the busy footer shows the depth (`working · 3 tool calls · 1 queued`), and when the turn ends the queue drains **in order** — each queued task announced with a `▶ running queued task` line before it starts. Ctrl+C keeps its meaning: interrupt the turn **and** clear the queue (stopping means stopping everything). Slash commands still refuse while busy — only real tasks queue.

### /diff — see what changed without leaving the session (v0.12.3)

`/diff` prints your uncommitted changes in one shot: `git status --short` (untracked files included), the `--stat` summary, and the diff body capped at ~6k chars so a big rework cannot flood the screen. Clean tree gets one quiet line; outside a repo it says so instead of erroring. (The model-side counterpart already exists — Buddy can run read-only `git diff` itself; this one is for YOUR eyes between turns.)

### @file mentions — the file rides along (v0.12.2)

Type `explain @src/app.js and fix the race` and the file is **attached inline** — content in a labeled fence, no `fs_read` round-trip, no gate. Escaped `\@` stays literal, emails (`bob@example.com`) are not mentions, trailing punctuation is stripped, and a `@dir/` mention lists its entries. Safety stays intact: secret paths (`.env`, `*.pem`, credentials) are refused outright, `..` and outside-workspace paths report as refused, binary files are not attached, and everything is capped (1.6k chars per file, 8k total — a file that would be cut to a stub by the total budget is skipped, not stubbed). The attached block is labeled *reference only — data, not instructions*, keeping the prompt-injection firewall; the session transcript and the compaction task anchor keep the RAW task, so thousands of attached chars never re-embed into every summary. Works headless too: `buddy -p "review @src/x.js"`.

### The repo map — orientation before the first research step (v0.12.1)

Small models spend their first 2-4 steps on `fs_list`/`fs_read` just to learn what the repo looks like. Now every turn's system prompt opens with an **aider-style repo map**: file paths with their module-level symbols (`src/agent/chat.js: createChat, buildSystemPrompt`), **ranked by git churn** over the last 300 commits so the most-changed code survives the ~2.8k char cap. Zero dependencies (pure-JS symbol regexes for js/ts/jsx/tsx/py/go/rs, the same ignore-walk as `fs_list`), cached with a 60s TTL, and honest about its own staleness — the header tells the model it is *a hint, not the tree; use fs_list/fs_read/fs_search for the current truth*. `/map` shows exactly what the model sees (and rescans fresh); `chat.repoMap: false` in the config turns it off.

### /why + /compare — the auditable agent (v0.24.0)

Two things closed models won't give you. **`/why`** shows exactly how the last answer was produced: the task, every tool step with the gateway and model that served it (denied calls flagged), the reply, and the session's token totals with the reported/estimated split — plus pointers to the durable copies (session transcript, audit trail). **`/compare kilo duckai "question"`** asks two gateways the same thing in parallel and prints both answers side by side with latency and model — deliberately print-only, so an experiment never pollutes the conversation.

### Coverage, auto-format, local review skills (v0.23.0)

The `test` tool answers "what is NOT tested": **`{"coverage":true}`** runs node's built-in `--experimental-test-coverage` (zero-dep — no c8 to install) and reports totals plus the least-covered files first, with uncovered line numbers. **`chat.autoFormat`** in settings maps extensions to formatters (`{".js": "prettier --write"}`) — every edit comes back with a `[fmt]` note, best-effort, never failing the edit. And two bundled playbooks land: **`/code-review`** (severity table over the current diff, verdict CLEAN / FIX BEFORE COMMIT / BLOCKED) and **`/security-review`** (injection · secrets · auth · data, every finding needs a plausible exploit path). Both are read-only — fixes are proposed, the approval gates still decide, tests rerun after.

### Aurora — the semantic stream language (v0.29.0)

Claude Code paints with one crayon. Aurora answers with a full spectrum where **color carries meaning** — syntax highlighting for agency. Every tool family gets its own hue + glyph (bash `▸` green, reads `▤` blue, writes `✎` violet, git `⎇` orange, web `◉` cyan, plans `☑` magenta, subagents `⧉` amber, MCP `⇄` teal), every tool card carries a **dotted leader to a right-aligned duration** (`▸ bash npm test ············· 1.2s`), and every observation opens with a verdict mark (`⎿ ✓` green / `⎿ ✗` red) so failures pop out of a long run without reading a word. The single dim thought line becomes the **Aurora strip** — a live 3-line rail above the input fed by raw gateway deltas: the verb state machine (`✻ thinking → forming → streaming → verifying`, each verb its own hue), the narration words as they land in quotes, the tool call being formed, and a telemetry line (`↓ 1.4k tok · 3 tool calls · 46s`) — all bordered by an animated green→cyan→violet gradient rail that sweeps while Buddy thinks. Turns close with a **done ribbon** (`● Done — 4 steps · 3 tool calls · 33.5s · ↓223 tok`) that is green when clean, amber on denials, red on errors, and submitted prompts echo in violet (`❯`). New `src/terminal/theme.js` degrades 256-color → 16 → mono; `NO_COLOR` and `/theme mono` silence the whole layer; **`FORCE_COLOR`** forces it on for CI. Plus two honest-infrastructure additions: `--record <file>` (a flight recorder that appends the TUI's pristine byte-stream — replayable in any terminal, diffable in CI, attachable to bug reports) and a keep-alive fix (the REPL no longer silently exits on pseudo-terminals whose stdin idles). Evidence from a live session ships in `download/aurora-evidence/` (strip, cards, ribbon screenshots + an animated GIF), captured through a real PTY.

### The data plane — db, secrets vault refs, API schemas (v0.41.0)

Three §10 items, one theme: talk to infrastructure the way Buddy talks to files — read-only by default, credentials as references, honest about what is NOT supported. **`db`** queries and inspects the project database: sqlite runs on `node:sqlite` (ships with node ≥22.5 — zero-dep by construction) with `action:"schema"` (tables → columns + row counts) and `action:"query"` with bound params; the database is **opened READ-ONLY in read mode**, so an un-gated write fails in the engine, not in our discretion — `mode:"write"` is `riskyWhen` and asks the approval gate. pg/mysql run through **the repo's own driver** (`node_modules/pg` / `mysql2` — probed, never bundled; absent driver = honest refusal naming the install command) with read mode wrapped in `BEGIN READ ONLY` / `START TRANSACTION READ ONLY`, and the connection taken from an **env-var reference** `{"conn_env":"DATABASE_URL"}` — a literal connection string in args is refused. **`secret`** is the vault integration where values never enter the conversation: references (`env:NAME`, `pass:entry/path`, `op://Vault/Item/field`) resolve at call time — `pass show`, `op read`, env lookup — and only the CONSUMER ever sees the value: the `http` tool's auth now accepts `{"type":"bearer","ref":"pass:github/token"}` (env refs keep working; both at once is refused), the value lands only in the outgoing header, and `secret check` reports backend + length, nothing more. **`schema`** pulls API contracts into context: `action:"openapi"` reads a JSON spec (url or project file — YAML is refused honestly with the convert-once hint), summarizes every endpoint with param/body/response types, and `write_stub:true` generates `<name>.client.js` — a zero-dep fetch client, one function per operationId, path params encoded, query params serialized, JSDoc types from the spec's own schemas (gated like any file write); `action:"graphql"` runs a standard introspection query and summarizes the type system. Evidence: `download/aurora-evidence/infra41-readable/` — schema introspection on camera, the write gate, the masked secret check, the http-vault round trip with the secret provably absent from the transcript, and the stub written + imported live.



### perf + time-travel — profile the hot path, replay history with one edit changed (v0.40.0)

The §5 finale, both items in one wave. **`perf`** profiles ONE entry invocation and returns a structured hotspot table instead of 40k of profiler soup: node via `--prof` + `--prof-process` (both ship with node — zero-dep by construction), python via `cProfile` + a pstats JSON dump (stdlib), and `mode:"pyspy"` uses `py-spy record -f speedscope` when the binary exists (absent binary degrades to cProfile with the hint on the card, never a crash). Validation is the honesty surface: pipes, chains, redirects and package-manager wrappers are REFUSED with the reason — `--prof` through `npm test` profiles npm, not your code, and the tool says so instead of pretending. Artifacts (V8 isolate logs, pstats, speedscope) land in `.buddy/perf/` and the observation names them for deeper digging; `risky: true` — it runs code, same gate class as bash. **Time-travel** is the checkpoint store's (v0.9.7) second act: "replay from step 7 with this one edit changed". `time_travel` (dry run) parses a saved session into numbered steps and prints the replay plan — the fs window, the swap preview, and an honest skip list (bash/git/web are non-deterministic, not modeled); `time_travel_apply` (gated) executes it: reconstruct the pre-window base from the session's own earlier writes, backfill any file the session never wrote from its pre-write checkpoint snapshot, cross-check reconstructed bases against the store's hashes (`verified` / a loud `MISMATCH` — a disagreement is on the record, never swallowed), then apply the window with the swap and write the what-if state behind ONE `retrace` checkpoint — so `/rewind` undoes the whole replay in one step. The fuel is a deliberate recording-policy change: session tool events now carry a `retrace` record with the FULL fs args for plain edits (the args `_preview` stays a 160-char hygiene preview) — secret paths never carry content into the transcript (`secret:true`), oversized args record `tooLarge`, and pre-v0.40 sessions degrade honestly to "unrecorded". One-shot surface: `buddy --retrace [name] --from N --until M --swap K --set '<json>'` (dry run by default, `--apply` to execute). **The drill caught three real bugs**: the session recorder's 160-char observation cap amputated the retrace reports from the record (→ 1200); the cross-check compared the POST-replay content against the pre-write hash — flagging a legitimate swap as a MISMATCH (now it checks the BASE, and store-sourced files skip the tautology); and the driver's gate look-back window (9000 chars) was pushed out by two minutes of spinner repaints (→ 40000, the newest-⚠-wins logic absorbs it). Evidence: `download/aurora-evidence/v40-readable/` — the perf gate, the expanded hotspot table (`1. 89 ticks 64.0% JS: *hotLoop`), the dry-run plan with bash in its skip list, the apply gate naming the swap, the what-if landing (`status.md = "ship what-if v1"` — the original "ship final v1" gone), the retrace checkpoint manifest, all at the readable 80-column geometry with close-ups.

### Decision rationale + replayable narration — the why on every card, the session as a film (v0.37.0)

The last two §7 items in one wave. **Decision rationale**: the protocol grows an optional `"why"` key — one short sentence, tool calls only ("why this file, why this edit"). `extractWhy` caps it at 240 chars with a clean ellipsis (a rationale is a sentence, not a `…[+N chars]` preview), and it rides every surface that answers "what did you do and why": the session JSONL (live AND detached-turn recorder paths), `.buddy/events.jsonl`, the tool card itself — a dim italic `why:` line between the head and the observation, with cards that carry no why byte-identical to v0.36 — the `/events` table, and the markdown + HTML exports (whys under the tool tally, in call order). Deliberately **not** persisted back into the model's history: rationale is for humans, not token burn; steps without one carry no key at all. **Replayable narration**: `buddy --replay [name]` turns any saved session into a paced film — gaps come from the session's own `at` stamps at 0.35× wall, clamped 150ms–4s (a replay that takes as long as the session is a documentary nobody finishes); frames paint through the SAME renderers as the live run, so the film looks like the session felt. Raw keys on camera: space pauses, `n` paints the next frame now, `[`/`]` walk the 0.5–8× speed ladder, `q` quits with an honest `replayed N/M events — the JSONL stays untouched` line; per-frame status shows the counter, the timeline length and the speed. Read-only by construction, and `--replay` runs BEFORE `--worktree` isolation — a replay wants the sessions of the directory you are IN. `/replay` inside the REPL points at the door instead of pretending the input box can share. **The drill caught a real bug in the player itself**: the status label divided ms→s and then fmtClock divided again — every film announced `0s timeline` (fixed as `timelineMs()`, pinned). Evidence: `download/aurora-evidence/replay/` — the live turn where all 6 tool cards carry their why (the fenced-heading fix, `fix: fix extractHeadings` drafted from the staged diff) and the replay of that exact session: pause at 1×, `]` → 2×, `n`-stepped cards with their whys, the shell frame, `replayed 11/11 events`.

### Plugins — ONE folder bundles skills · agents · commands · tools · reporters · mcp (v0.39.0)

The §3 wave. Buddy already loaded user extensions from half a dozen `.buddy/` folders; a **plugin** is the unifying bundle: one folder with a required `buddy.plugin.json` (`{name, version, description, hooks?}`) carrying any mix of `skills/ · agents/ · commands/ · tools/ · reporters/ · mcp.json` (hooks live in the manifest, same shape as settings). Install: **`/plugin add <owner>/<repo>`** (`git clone --depth 1`, staged into `.staging-*` first and manifest-validated — a broken install never leaves half a plugin behind), a **local path** (cloned if it is a git repo, copied otherwise), or a **bundled pack name** (`/plugin add pack-nextjs` copies from this package's own `packs/`). **`/plugin`** lists what's installed with a bundle summary and on/off state; `enable/disable` persists to settings `plugins.disabled` (disabled plugins stay on disk but contribute nothing); `remove` deletes the folder; **`/plugin browse`** shows the bundled marketplace seed (`marketplace.json` ships in the package — offline by construction; settings `plugins.marketplaceUrl` can swap in a live catalog with one 5s-capped fetch that falls back to the seed honestly). Every existing loader gained the plugin layer with one collision rule everywhere — **project > personal > plugin > bundled**: skills load between bundled and personal, agents/commands/user-tools lose to the user's own files, manifest hooks append to the hook map, mcp fragments merge with project-config-wins (collisions and junk fragments land in `/mcp`'s failed list, never a crash), reporters merge with in-base sorting so priority survives the path sort. `/skills` and `/agents` now scan LIVE, so a mid-session install is visible immediately; plugin tools join the registry at the next session start (the add output says exactly that), and the startup banner prints the plugin line. Two real packs ship in the box: **`packs/pack-python`** (language pack: the `python-qa` playbook + `/py-qa`; the analyzer half rides the v0.17 LSP client) and **`packs/pack-nextjs`** (framework pack: the `nextjs-app-router` playbook + `/nextjs-page`). Tool composition stays in its stage-1 form on purpose — the agent loop IS model-driven chaining (`greet → fs_write` in the drill, `fs_read → fs_replace → git_write` in the v0.36 drill) and free-model brains profit from one tool call per turn, not a second mini-language; explicit pipe syntax stays documented as open. **The drill** (two sessions): `/plugin` empty state → `/plugin browse` (seed on camera) → `/plugin add pack-nextjs` ("1 skill · 1 command") → the pack's skill in `/skills` → `/plugin add /tmp/demo-plugin` — a REAL `git clone` ("1 skill · 1 command · 1 tool · 1 hook") → restart → `/tools` lists `greet` → the task calls it through its approval gate ("hello checklist — from the demo-plugin tool"), writes `GREETING.md`, and the plugin's PostToolUse hook FIRES (the hook log's line is on disk) → `/plugin disable demo-plugin` → the final table shows demo-plugin OFF, pack-nextjs ON. **The drill caught a real bug**: `connectMcpServers`' final return overwrote the merge-phase `failed` list — plugin collisions and junk fragments were computed and then silently dropped; fixed and pinned. Evidence: `download/aurora-evidence/plugins/`.

### Sandbox mode — bash with the network off + a restricted HOME (v0.38.0)

The §9 closer. `/sandbox on` flips every model-driven `bash` call into a Linux **user+network namespace** (`unshare -rn`, probed once with `unshare -rn true` — capability is verified, never assumed): the namespace has no interfaces beyond a DOWN loopback, so DNS and sockets fail **instantly** (an 8ms EAI_AGAIN, not a 30s timeout), and `HOME` points at an empty per-project dir (`.buddy/sandbox/home`), so `~/.ssh`, `~/.aws`, `~/.netrc` are simply not there. Files created as mapped-root inside land owned by the real user outside — builds still write, nothing root-owned litters the repo. Every sandboxed observation carries an honest `[sandbox: net off · home restricted]` tag, the bash tool description grows a `SANDBOX IS ON` warning at the next prompt build (a getter, so `/sandbox` mid-session re-teaches the model live), `/status` shows `sandbox: ON`, and the flag persists in `settings.json` (`chat.sandbox`) — headless `-p` runs inherit it. Degradation is said out loud, never faked: non-Linux or userns-disabled machines keep the HOME restriction and the status block prints `network NOT isolated`. Scope, deliberately narrow: only the model's bash tool — approval-gated tools keep their own gates, and your own `!` shells are never sandboxed (you typed them). For a hard boundary `/sandbox profile` prints the strong option: a real `docker run --network none` / rootless `podman run` profile with the boundary spelled out (git_write push and web tools intentionally fail there — that is the point). **The drill**: `/sandbox on` on camera, then a real task — DNS for the npm registry fails in 0.0s with the tag on the card, `printenv HOME` shows the sandbox dir, `node --version` still works, findings land in NET.md — then `/sandbox off` and the SAME command resolves. The difference between the two legs IS the proof. Evidence: `download/aurora-evidence/sandbox/`.

### Git-native commits & PRs — drafted messages, the PR flow, --worktree isolation (v0.36.0)

The rest of §9 in one door. **`commit` learns to draft**: `git_write {op:"commit", generate:true}` (or any commit without a message) builds a conventional-commit draft deterministically from the staged diff alone — `src/tools/commitmsg.js` classifies the change (test/docs/deps/ci/config/code ratios → `fix:` when code changed with tests alongside, `feat:` for new source, `chore(deps):` for manifests), infers the scope from the dominant directory, and takes the subject from git's own **hunk headers** (`@@ … @@ function extractHeadings` → `fix: fix extractHeadings`) with a body that names the new/changed/removed files and the +/− shape — honest about being a draft, and an explicit message ALWAYS wins. Every drafted (or explicit) commit body gains the **Co-Authored-By trailer** (`BUDDY_COAUTHOR` to rename, `BUDDY_NO_COAUTHOR=1` to drop, never duplicated). **Two new ops**: `push` (plain push that sets upstream — force refused unless `force_with_lease:true` is asked for explicitly, and it still goes through the same gate) and the **`pr` flow** — `{"op":"pr","branch":"fix/x","base":"main"}` runs branch → stage → commit (drafted) → `push -u` → the `gh pr_create` handoff as ONE previewed plan, stopping at the first failure with every step's git output in the result; it skips the commit when the branch already carries new commits and refuses an empty PR (head even with base) with the explanation instead of a vague stage error. **`--worktree`**: `buddy --worktree` isolates the run in `.buddy/worktrees/<slug>/` on a fresh `buddy/<slug>` branch — the user's dirty tree stays theirs, the worktree OUTLIVES the run on purpose, and the exit note (interactive AND one-shot) prints the exact review/remove commands. **The live drill caught two real bugs**: staging used `git add -A -- . ':(exclude).buddy'`, which exits 1 in any repo that actually gitignores `.buddy` (a pathspec naming an ignored path trips git's advice — every unit fixture passed because none had one); now plain `add -A` + `rm --cached --ignore-unmatch`, pinned for both worlds. And the worktree kept-note only rode the interactive exit hook — one-shot runs never saw the removal command. Evidence: `download/aurora-evidence/gitnative/` — the drill end to end (a real fix→test→PR task through a scripted brain but REAL gates and git: the 5-step PR plan gate, `commit: 08101f8 fix: fix extractHeadings (drafted)` on camera, the all:true draft preview, the push gate, the worktree isolation proof with `main_has_maintainers: false` + the branch's two commits + the trailer, and the replay GIF).

### The gh tool — GitHub/GitLab over REST, /ci, /pr-comments (v0.35.0)

The checklist §6/§9 pair in one door. A new **`gh` tool** (`src/tools/ghapi.js` + a zero-dep GitLab client, `src/tools/gitlab.js`) gives the agent — and two new slash commands — the forge: provider **auto-detected from the origin remote** (github.com/gitlab.com; self-hosted hosts name the `BUDDY_GITHUB_API`/`BUDDY_GITLAB_API` override instead of guessing), tokens only ever from **the user's env** (`BUDDY_GITHUB_TOKEN` → `GITHUB_TOKEN` → `GH_TOKEN`; GitLab twins) with a credential **embedded in the origin URL** as fallback — and remote URLs are sanitized everywhere, so an embedded token can never reach the transcript, an error message, or the model. Ops: `pr_view`, `pr_list`, `pr_comments` (inline comments grouped by file, reply chains folded to the root, review bodies included), `ci_runs` (provider-agnostic states — GitHub workflow runs and GitLab pipelines normalize to one table), and gated writes `pr_create` / `pr_comment` / `pr_review` (GitLab approve/note; inline review comments honestly refuse rather than fake it). **`/ci [branch]`** renders the latest run per branch (or every run of one branch) in color; **`/pr-comments [n]`** pulls a PR/MR's review comments (no arg = your current branch's PR) and **attaches them to the next task** the way /docs and /report do — the review reaches the model without a copy-paste. Both commands are busy-safe (usable mid-turn, in the v0.34 allowlist). **The drill caught a real product bug**: the clients' retry loop auto-resended **writes** on network errors — a stalled pr_comment produced NINE identical POSTs on the mock's log (a timed-out write may have landed; resending it double-posts); writes now fire exactly ONE request and surface the error honestly, pinned by tests. Evidence: `download/aurora-evidence/ghapi/` — the mock-forge drill end to end (/ci dedup on camera, comments grouped with replies folded, attach ride-in, edits through the gate, 4/4 tests, the acceptance comment posted exactly once), the before/after write-retry A/B (1m36s + 3 POSTs → 30.0s + 1 POST against a black-holed route), GitLab provider switch, the honest self-hosted error, and the REAL forge segment: real Actions runs on this very repo via the embedded-credential path plus the model calling `gh pr_list` against the real API unprompted.

### Background turns — ctrl+b detaches, the prompt stays yours (v0.34.0)

Claude Code's ctrl+b, rebuilt on the mutex the v0.33 deferral demanded. Mid-turn **Ctrl+B** detaches the running turn: its live output mutes into a per-task record (`src/terminal/tasks.js` — 400-line buffer, live step/tool/token counters), the busy footer releases, and the prompt is immediately yours — run `!shell` commands, `#remember` notes, or any of ~23 read-only/box-local slash commands (a safe-while-busy allowlist; state mutators still refuse, naming the running task). New messages queue with a note naming what they wait for. **`/tasks`** lists detached turns plus background shells in one view; **`/tasks view t1`** reads the muted buffer's tail — the tool calls that happened while quiet, proof the turn really worked; **`/tasks stop t1`** interrupts (esc/ctrl+c deliberately never kill background work); **`/tasks attach t1`** pulls the running task back to live rendering. Completion prints one compact outcome-coded line (`✓ bg t1 done · 14 steps · 14 tools · 35.6s · ↓187 · /tasks view 1 for output`) instead of the ribbon — the foreground stays quiet — and a queued message auto-starts attached. While detached the footer itself names the task with a `bg t1▶` status marker; an approval gate auto-reattaches so a y/n question is always answerable; `/exit` names the running task instead of killing it. **The review pass caught a pre-existing mutex bug the feature made trivially reachable**: `!cmd` and slash commands did `busy = true … busy = false` unconditionally — running `!git status` during a turn released the mutex and let a second `chat.turn()` interleave conversation history; both paths now save/restore. Session truth never mutes (session JSONL, events log, /copy register). Evidence: `download/aurora-evidence/bgtask/` — detach at 20s of a real fix-task, `!node --test` already green mid-bg (the task fixed the file while muted), the muted buffer on screen, attach resuming live, the queued turn auto-running; GIF + MP4.

### Tool cards that keep the verdict, a real clipboard, multi-line drafts, vim (v0.33.0)

Four §8 checklist items in one wave, each proven on a live build/debug run. **Better tool cards**: the v0.29 card kept the HEAD of a long observation — but test runners and compilers print their verdict at the END, so a failing suite's summary was invisible behind `…+130 more lines` (the before-shot's last visible line was literally a split-ANSI fragment, `39m,`). The collapse policy now keeps 2 head + 2 TAIL lines on long outputs with an honest hint that names the clipboard key (`…+131 hidden lines — the tail is kept (verdicts live there) · /copy 1 for all · ctrl+o expands`); verbose cards scale the same policy and can never show less than their collapsed twin. **`/copy <n>`** copies any of the last 10 observations — or `/copy reply` for Buddy's last answer — to the system clipboard via **OSC 52**: zero dependencies, consumed by the emulator itself (iTerm2, kitty, WezTerm, alacritty, foot; tmux with `set-clipboard on`), works over SSH. **Multi-line input**: ctrl+j and alt+enter insert newlines — the wire truth pinned by a live readline probe (`\r` submits, the LF byte inserts, `ESC+CR` arrives coalesced); ↑↓ navigate the draft's own lines first and recall history only at the edges; the frame's cursor mapping went newline-aware (the old loop drifted one row per `\n`) with char→visual conversion for CJK carets; ctrl+u/ctrl+k/home/end became line-scoped. **`/terminal-setup`** detects your terminal and prints the exact shift+enter→0x0A binding (reconfiguring your terminal for you is deliberately not automated). **`/vim`** toggles modal editing: a pure reducer (`src/terminal/vim.js`) feeding the box's own switch — hjkl/w/b/e with counts, `0/$/^`, `gg/G`, `i/a/I/A`, `o/O`, `x/X`, `D/C`, `dd/yy/cc`, `p/P` (linewise + charwise), modal esc that never arms the rewind chord, `/` still opening the palette, questions bypassing vim entirely, `vim` in the status right. The drill **caught a real bug**: the reducer submitted the LF byte mid-composition because readline sends ctrl+j as `{name:'enter', ctrl:false}` — not the ctrl chord the unit test fantasized; v0.33.1 mirrors `applyKey`'s enter contract and replaces the fantasy-shape test with wire-shape tests. Evidence: `download/aurora-evidence/vimcards/` — the before/after card pair, the register table, the OSC 52 payload decoded straight off the wire (6,153 bytes / 137 lines of the raw failing run), the two-line vim draft, `/terminal-setup`, GIF + MP4.

### Rewind menu — double-esc (v0.32.0)

The checkpoints store (v0.9.7) and `/rewind` command existed, but the keyboard didn't know. **Double-esc** — two *consecutive* escapes inside one second, any other keypress disarms — now opens the **rewind menu**: an Aurora panel over the input box listing the last 10 checkpoint manifests (`1  09:14:03  fs_replace  src/cart.js`), newest first with the same numbering as `/rewind`. `↑↓` (or `k`/`j`) move, **enter restores files to before that step** — one undo per restore, the applied manifest is consumed exactly like the command — and `esc`/`q`/`ctrl+c` close. While open the menu owns every key: the draft, the session and a pending question are untouchable, and the restore result prints into scrollback through the renderer like any other card. The chord refuses to fire where it would be dangerous: a palette or question-mode escape never arms it (approval gates are untouchable), and mid-turn both escapes keep interrupting — the menu is an idle affordance (though an interrupt pair stays armed, so the first idle escape right after a `esc esc` interrupt opens it, Claude Code style). Narrow panels drop the time column so paths keep real room; every row is width-capped at every terminal size. New `src/terminal/rewind.js` holds the pure half (chord predicate, menu key reducer, panel painter) under unit test; repl.js wires the menu to the real `listCheckpoints`/`restoreCheckpoint` store. Documented in `/help` (`double-esc`).

### Transcript — the ctrl+r session viewer (v0.31.0)

Claude Code's ctrl+r binding, rebuilt on the Aurora render layer. **Ctrl+R** opens the session transcript — a scrollable panel over the input box showing everything Buddy actually did, in its own colors: violet `❯` prompts, family-hued tool cards with verdict marks, markdown replies, done ribbons. The capture needs no new plumbing per feature: every scrollback byte already flows through the mini-Ink renderer's single `print()` choke point, so the viewer replays the session **exactly as it was painted** — SGR kept, cursor moves/OSC/`\r` artifacts stripped, capped at 2000 lines (old lines fall off the top). Browsing is pager-grade: `↑↓` scroll by line, `pgup/pgdn` by page, `g`/`G` (or `home`/`end`) jump to the top / back to the **live tail**, `esc`/`ctrl+r`/`q`/`ctrl+c` close. While open the editor is **inert** — no key can mutate your draft, interrupt the turn or quit the session — and a running turn keeps streaming: new cards land at the tail (`turn still running` in the footer) on the 120 ms spin tick. New `src/terminal/transcript.js` holds the pure half (sanitize, viewer key reducer, panel painter) under unit test; the input box owns the buffer and the key routing. Footer hint updated (`ctrl+r transcript`).

### Expand — collapsible thinking, ctrl+o (v0.30.0)

The Aurora strip narrates on **one width-capped line** — great for scanning, lossy for long thoughts: everything older than the last ~60 characters vanishes behind an ellipsis. **Ctrl+O** (Claude Code's transcript binding) now toggles the **expanded transcript**: the narration wraps into a mini transcript of up to 3 rows where the LAST rows win, so the newest words of a long stream stay on screen, the closing quote lands when the message completes, and the gradient rail extends over every row. The same toggle widens tool observations from the collapsed 5-line / 400-char excerpt to 24 lines / 1200 chars — a test suite's full output stays on the card instead of `… +N more lines`. Press ctrl+o again to collapse. The toggle is live everywhere: the strip repaints on the next 120 ms tick, `/verbosity` (which now applies **immediately** — a latent ref-vs-value bug made mid-session changes never take effect) and observations follow on the next card. Footer hint updated (`ctrl+o expand`).

### Streaming thoughts — Buddy thinks out loud (v0.28.0)

While Buddy works, the busy footer grows a **live thought line** fed by the brain's raw deltas — the tool name the moment `"tool":"bash"` completes, the command being typed character by character, and the actual words of a reply unescaping in real time (`✻ I'll add the guard first…`). Every keyless gateway streams now: kilo/llm7/pollinations via OpenAI-style SSE with usage in the final chunk, duckai incrementally (it was always SSE — now the body isn't buffered), ollama NDJSON for the offline path. **`/stream off`** (persisted) returns to quiet buffered replies; one-shot/CI never streams. Stall-safe: 45s without a byte aborts the body and the router fails over — a stalled relay can no longer hang a turn (the old buffered path never capped body reads at all). Deltas are display-only; reply parsing is untouched.

### Make it yours — verbosity, themes, output styles, statusline (v0.22.0)

Four knobs, one shared `.buddy/settings.json` (deep-merged — a UI tweak can never wipe your hooks or permission rules). **`/verbosity silent|summary|verbose`** — replies only, tool cards, or cards plus observation tails; applies mid-session. **`/theme dark|light|high-contrast|mono`** — the painter registry swaps in place so every render re-themes instantly (`NO_COLOR` always wins). **`/output-style <name>`** — a markdown file in `.buddy/harness/output-styles/` whose body REPLACES the whole system prompt (frontmatter `description:` feeds the lister; `default` restores). **`/statusline "{branch} · {gateway} · {ctx} · {todo}"`** — a template rendered under every turn footer, placeholders vanish when empty.

### Branch, fork, share, import — conversations you can carry (v0.21.0)

Try a direction without fear: **`/branch save try-x`** snapshots the live conversation, work freely, **`/branch try-x`** switches back — your previous line is auto-parked (`auto-HHMMSS`), nothing is ever lost, `/branch` lists everything. **`/fork experiment`** copies the session file on disk (collision-safe `-2`, `-3`…) while the live session keeps running. **`/share`** renders the whole transcript — user, buddy, tool calls, shell passthroughs — into ONE self-contained HTML file (inline CSS, zero external resources, content HTML-escaped) in `.buddy/exports/`. And **`buddy import <session.jsonl>`** validates and restores a shared session on any machine — `buddy -r <name>` picks it right up. Team context travels as a file.

### Git tool — parsed repo state, not shell soup (v0.20.0)

One read-only `git` tool with seven ops — `status` (porcelain decoded into a human table with new/modified/deleted tags), `diff` (stat), `diff_patch` (capped), `log`, `blame`, `branch`, `show` — output parsed, capped, and honest about errors (`not a git repository`, unknown paths). Write operations (commit, push, merge, rebase, reset) are **refused by design** with a pointer to the bash approval gate: reading the repo is free, mutating it stays human-gated. Read-only means no approval gate and full availability in plan mode.

### Permission rules + audit trail — policy instead of prompts (v0.19.0)

Rules replace reflexive yes/no: `permissions.allow / deny` in `.buddy/settings.json` (project) and `~/.buddy/settings.json` (user, merged first), patterns like `Bash(git *)`, `fs_write(docs/**)`, `fs_write(.env*)`, and **domain rules** — `WebFetch(domain:github.com)` with real host-suffix matching (`api.github.com` yes, `notgithub.com` no). Verdict order is **deny > allow > defaultMode** (`ask` | `allow`); `/yolo` flips remaining asks to allow but NEVER a deny. In the loop, deny refuses with the exact rule named, allow skips the gate entirely, ask hits the normal approval. `/permissions` shows the table; **`/permissions test bash {"command":"git status"}`** evaluates a hypothetical call before you commit to a rule. Every tool call also lands in the append-only **`.buddy/audit.jsonl`** — who, what (exact args), when, verdict — best-effort, never breaks a turn.

### Headless complete — CI-grade -p, sessions you can name (v0.18.0)

`buddy -p` existed from day one; now it is CI-grade: **pipe the task in** (`cat task.md | buddy -p` — bare `buddy` with piped stdin runs headless too), pick the **output format** (`-o text|json|stream-json` — `json` emits one result object `{status, said, steps, gateway, model, toolCalls}`; `stream-json` emits one JSONL event per step plus a final `{type:'result'}` line, both suppressing human rendering), and trust the **exit codes** (0 ok, 1 no reply, 2 usage). Sessions got continuity: **`buddy -c`** continues the newest session in the directory, **`buddy -r <name>`** resumes a named one, and **`/rename fix-auth`** names the current session mid-flight (sanitized, conflicts keep both files) — so `-p` can pick up where the REPL left off: `buddy -p "now add tests" -c`.

### LSP + /docs — compiler-grade checks and official docs in context (v0.17.0)

Buddy now speaks **LSP**: if your repo's language server is installed (`typescript-language-server`, `pylsp`, `gopls`), Buddy spawns it over stdio JSON-RPC (Content-Length framing — not the newline-delimited MCP dialect) and gains `lsp_diagnostics`, `lsp_goto_def`, and `lsp_refs` — the type-aware versions of the regex navigation tools. The big one is **diagnostics after every edit**: fs_write/fs_replace/fs_append/multi_edit append `[LSP] N diagnostics — X ERRORS` to the observation, so breakage feeds back to the model WITHOUT running the test suite. No server installed? One remembered spawn attempt, honest install hints, zero crashes — and `chat.lsp: false` turns it off entirely. Plus `/docs <lib> [query]`: official docs from devdocs.io (≈400 libraries), stripped to text, windowed around your query, printed to the terminal AND attached to your next task as labeled reference data (injection firewall applied). 404s answer with `did you mean:` from the devdocs catalog.

### Symbol index & impact — navigate the code like an IDE, zero-dep (v0.16.0)

The repo map shows what the repo looks like; the symbol index shows **where things are and what they touch**. A regex index (defs at any indent — functions, classes, defs, fns, types — with kind, signature and line) plus a resolved relative-import graph power four read-only tools: `symbol_search` (find a definition by name, exact → prefix → substring), `go_to_def` (jump — ambiguous names list every candidate by file), `find_refs` (every word-boundary reference, honestly labeled as a regex index that includes comments, not a compiler), and `impact` — *"what breaks if I change this?"* — which prints the def site, `imported by:` (graph edges) and `referenced in:` (name refs outside the defining file). All four are in the plan-mode allowlist, so research can navigate before a single edit is proposed. Cached with the same 60s TTL discipline as the repo map.

### MCP server mode — other agents can drive Buddy (v0.15.0)

Symmetry with the MCP client: `buddy mcp-serve` turns Buddy itself into an **MCP stdio server** speaking the exact wire format our client implements (newline-delimited JSON-RPC 2.0, `initialize` → `tools/list` → `tools/call`, protocol violations as JSON-RPC errors, tool failures as `isError` results so one bad call never kills the transport). Any MCP host — Claude Code, opencode, another Buddy via `.buddy/mcp.json` `{"command":"buddy","args":["mcp-serve"]}` — can then read this repo (`buddy_fs_list` / `buddy_fs_read` / `buddy_fs_search` through the same LocalScope guards that refuse secret paths, `buddy_repo_map`), run its tests (`buddy_run_tests` — the real auto-detecting test tool), and read the **shared todo plan** (the `todo` tool now persists to `.buddy/todo.json`, making Buddy's plan a durable cross-agent surface). The mutating pair — `buddy_fs_write` and `buddy_apply_patch` — ships **disabled** and refuses with the exact fix until the server is restarted with `--allow-writes`: the driving agent's own approval gate is the intended human door. stdout carries protocol only; logs go to stderr.

### User-defined tools — Buddy's third hand, yours (v0.14.0)

Any folder in `.buddy/tools/<name>/` (project) or `~/.buddy/tools/` (personal) becomes a first-class tool in Buddy's registry: a `manifest.json` (`name`, `description`, `version`, optional `argsSchema`, `safe`, `deprecated`, `maxCalls`, `timeoutMs`) plus an `index.js` exporting `run(args, ctx)`. **Every call runs in a short-lived child process** — a tool that throws, calls `process.exit(3)`, or hangs forever returns an `ERROR:` observation; the REPL never dies (a 30s default timeout kills runaways; the author's `console.log` is redirected to stderr so the result channel stays one clean JSON envelope). Versioning is enforced — the version integer is required and shows in the prompt as `[user-tool v2]` — and `deprecated: "use X instead"` marks both the description and every result. The JSON Schema is honored twice: compressed into the prompt hint, and validated **before** the sandbox spawns (missing required args cost nothing). Security posture: user tools are approval-gated on first use like MCP tools (`safe: true` opts out), can never shadow built-ins/`task`/skills/MCP names, project wins over personal on collisions, and broken folders degrade to loud warnings at startup — never a crash. `/tools` lists everything with a one-line "add your own" hint.

### The `test` tool — a real debugging suite, not bash guesses (v0.13.4)

Buddy now ships a dedicated `test` tool with per-framework auto-detection: **node --test** first (zero-dep — it runs with no node_modules, this repo's own rule), then **pytest**, **go test**, and **npm test** as the fallback. The model can run the whole suite (`{}`), a single file (`{"target":"test/app.test.js"}`), a **single test** (`{"target":"test/app.test.js::the exact name"}` → `--test-name-pattern`, regex-escaped), or **rerun only the last failures** (`{"rerun_failures":true}` — the failure memory lives in the tool, one session, in order). Output is parsed into a structured verdict — `tests: N run · N passed · N failed · N skipped` + a `FAILING:` name list + a capped output tail — so the model sees the diagnosis, not raw TAP soup. Both node dialects are parsed (TTY spec `ℹ` and piped TAP `#`), and the child runner strips the parent's `NODE_TEST_CONTEXT` so Buddy's own suite can spawn nested runs. Not approval-gated: tests are the safe happy path.

### Image input — Buddy can look at your screenshots (v0.13.3)

`@shot.png` in a task attaches an **image**, not a text fence: the file rides as a base64 `data:` URL in OpenAI vision content parts, routed to **vision-capable gateways first** (pollinations — and kilo best-effort, since its free catalog mixes vision and text-only models; `gateways.<name>.vision: false` opts out). The transcript never carries base64 — history keeps a one-line placeholder (`[image attached: shot.png]`), so compaction, the char budget and the JSON protocol stay string-shaped; at call time the router expands the placeholder into real image parts for gateways that can see, and hands text-only gateways a stripped view with an honest `[image omitted]` note. Caps: 5MB per image, 2 per task, image parts never poison the context-limit estimate. Works headless too: `buddy -p "make this button blue @shots/before.png"`.

### Custom slash commands — your prompts, one keystroke away (v0.13.2)

Any markdown file in `.buddy/commands/<name>.md` (project) or `~/.buddy/commands/` (user) becomes `/<name>` — a reusable prompt template, Claude Code style. Frontmatter sets `description`, `argument-hint`, and `allowed-tools` (a comma list that restricts the run to those tools, the same enforcement skills use); the body takes `$ARGUMENTS` (the whole tail) and `$1..$9` (positional), and a template with no placeholder gets the argument tail appended. Project commands override user ones; built-in command names can never be shadowed; files are rescanned on every lookup so a newly dropped command needs no restart. `/help` lists them under "Custom commands". Like skills, custom commands are tasks: they queue when a turn is already running.

### Memory @path imports — durable notes that reference living docs (v0.13.1)

MEMORY.md can now pull repo files in: a **whole line starting with `@`** (`@docs/style-guide.md`) imports that file's content into every session's memory at assembly time — wrapped in `[imported: @…]` tags so the model knows it came from a file. The firewall carries over from `@file` mentions: inline `@tokens` (emails, prose) are never imports (`@@path` is the literal escape), `..` escapes and secret paths are refused, missing files become a **visible marker line instead of a silent drop**, and imports are capped (4k chars per file, 8k total, 3 nesting levels, circular-safe). `/memory` lists the imports a session will carry. `#note` quick-append still works exactly as before — imports and notes compose.

### Real token accounting — honest numbers, per-gateway windows (v0.13.0)

The old `/cost` showed chars÷4 and called it a day. Now the accounting has two sources and tells you which one it used: **gateway-reported usage** when the API provides an `usage` block (kilo, llm7, pollinations, ollama — the OpenAI-compatible shapes plus Ollama's native counters), and the **chars÷4 estimate** as the labeled fallback (duckai's SSE stream never reports). Compaction calls are on the books too — they are real brain calls with real prompt sizes. The router now also **enforces per-gateway context windows** (`kilo ~32k, llm7 ~32k, pollinations ~8k, duckai ~8k, ollama ~4k tok` by default): a request too big for a gateway's window skips it *before* burning a timeout on a call the server would only reject, the all-gateways-failed report says which window rejected what, and when **no** window fits the biggest ones are tried first (a maybe-rejected call beats never calling). Every limit is overridable in `buddy.config.json` via `gateways.<name>.ctxLimit`. `/cost` shows tokens in/out with the source label (`gateway-reported` / `chars ÷ 4 est.` / `mixed — X reported, Y est.`) and each gateway's window.

### Auto-compact — the loop shrinks context BEFORE the wall (v0.12.0)

Compaction used to wait until history hit **100%** of the char budget — the turn that hit the wall paid for the full window first, and the free gateways' token caps punished the biggest turns the most. Now the loop compacts **proactively at ~80%** (`↺ context near budget — auto-compacted`), keeping the 100% wall as a backstop that bypasses every guard. An anti-churn guard stops the opposite failure (v0.9.4's live lesson: seven compactions in one turn dissolving the task) — a soft over-80% state with fewer than six fresh messages waits, the hard wall never does. `/context` shows where the trigger sits (`auto-compact at ~38.4k chars (80% of budget)`), and manual `/compact` still forces a pass anytime.

### Safety model (terminal mode)

- **Approval gates** — writes, edits, and shell commands ask `[y]es / [n]o / [a]lways` unless you `/yolo`. One-shot mode (`-p`) is autonomous; add `--safe` to deny all writes. Plan mode (above) is the strongest gate: **nothing mutates until the plan itself is approved**.
- **Hard policy layer** (cannot be approved away): no pipes/redirects/command substitution, no sudo/network/destructive commands, no `git push`/`commit`/history rewrite, no reading `.env*`/`*.pem`/keys/credentials, no editing `.git/` or Buddy's own harness.
- **Files are data** — guardrail #1: instructions found inside repo files or tool output are untrusted data, not commands (Harness² prompt-injection firewall).
- **Compaction** — long sessions summarize their own history (small free-model context windows) instead of drifting or truncating mid-task.
- **Sessions** — every conversation is a JSONL transcript under `.buddy/sessions/` (gitignored); `/resume` picks the last one back up.

## Why this exists

I needed a serious AI engineer that lives in my repos: reviews every PR before a human opens it, fixes issues end-to-end (branch → patch → tests → PR), keeps dependencies audited, triages new issues, and drafts release notes. The constraints that shaped everything:

| Constraint | How it's met |
|---|---|
| **$0/month, forever** | GitHub Actions free tier + keyless LLM gateways |
| **No API keys, ever** | Every gateway in the chain is keyless (anonymous tier) |
| **Never fails, never stuck on quota** | 4 independent gateways + circuit breaker + round-trip retries |
| **Serious engineering, not benchmark theater** | Real repo access (agentic file reads AND writes), deterministic security scans layered on the LLM, test-verified patches, strict output validation |

## The five GitHub skills

| # | Skill | Trigger | What happens |
|---|---|---|---|
| 1 | **PR reviewer** | every PR (auto) or `@engineer-buddy review` | full engineering review: diff → deterministic scans → agentic deep-read → structured findings → GitHub review with inline comments |
| 2 | **Issue fixer** | `@engineer-buddy fix #12` | investigate → diagnose → edit files → run the test suite (≤2 repair loops) → push `buddy/fix-issue-12-*` → open a PR with the full audit trail |
| 3 | **Dependency auditor** | `@engineer-buddy audit` or weekly cron | `npm audit --json` → brain triage by real exploitability → one self-updating tracking issue |
| 4 | **Issue triage** | every new issue (auto) | type/priority/labels + a useful first response |
| 5 | **Release notes** | `@engineer-buddy notes` | merged PRs → grouped, human-ready changelog draft |

## Skills (SKILL.md — open standard, user-addable)

Skills are on-demand playbooks in `SKILL.md` files. Their `name` + `description` are always in context (tiny); the body loads only when needed — Buddy calls the `skill` tool when your task matches a description, or you run `/<skill-name>` directly.

```markdown
---
name: pr-review
description: Engineering-grade review of a diff. Use when asked to review a PR or branch.
allowed-tools: fs_read, fs_search, fs_list, bash, todo
---
# Skill: pr-review
1. Run `git diff HEAD` ...
```

Three layers, later shadows earlier by name:

| Layer | Location | Scope |
|---|---|---|
| **bundled** | shipped with Buddy | the 5 CI playbooks below, usable in your terminal |
| **personal** | `~/.buddy/skills/<name>/SKILL.md` | you, in every repo |
| **project** | `.buddy/harness/skills/<name>/SKILL.md` | this repo only |

- `allowed-tools` is enforced: while a skill is active, tools outside the list get an ERROR observation until the turn ends (`say` and `skill` always allowed).
- `disable-model-invocation: true` hides a skill from the model — only you can run it via `/<skill-name>`.
- Supporting files (`.md/.txt/.json/.csv/.yaml`) next to a SKILL.md load through the same tool: `{"tool":"skill","args":{"name":"x","file":"checklist.md"}}`.
- `/skills` lists everything loaded with trigger mode, source, and tool restrictions.

The 5 CI skills are also bundled playbooks (`skills/*/SKILL.md`), so the same review/fix/audit/triage/notes rubrics now work inside your terminal — copy one into `.buddy/harness/skills/` and edit it to make it yours. The GitHub-bot pipelines in `src/skills/*.js` remain the CI execution layer.

## The keyless brain chain

All providers verified live on **2026-10-25**. No keys anywhere.

| # | Gateway | Endpoint | Models (free tier) | Notes |
|---|---------|----------|--------------------|-------|
| 1 | **Kilo Gateway** (the "OpenKilo" free tier) | `api.kilo.ai/api/openrouter/v1` | 13 `:free` models, auto-discovered (e.g. `nvidia/nemotron-3-ultra-550b-a55b:free`) | OpenRouter-compatible; `Authorization: Bearer anonymous` |
| 2 | **llm7.io** | `api.llm7.io/v1` | `codestral-latest`, `gpt-oss:20b`, `minimax-m2.7` | anonymous token is the literal string `unused` |
| 3 | **Pollinations** | `text.pollinations.ai/openai` | `openai` → GPT-OSS-20B (tools OK) | anonymous tier ≈ 1 req/30s per IP; bot parks it via `Retry-After` |
| 4 | **Duck.ai** (DuckDuckGo) | `duckduckgo.com/duckchat/v1` | `gpt-4o-mini` | unofficial, best-effort; JS challenge handshake |
| 5 | **Ollama (local)** — optional | `127.0.0.1:11434` | any local model | offline last resort; disabled by default |

The router fails over in order, opens a circuit breaker after repeated failures, parks rate-limited gateways for their exact `Retry-After`, and re-sweeps the whole chain up to 2 round trips. Tasks only fail if **every** gateway dies simultaneously — and even then the bot posts a polite notice instead of breaking CI.

## Commands

Comment on any issue or PR:

```
@engineer-buddy review          re-review this PR
@engineer-buddy fix #12         attempt a full fix of issue #12 → PR
@engineer-buddy audit           dependency audit → tracking issue
@engineer-buddy notes           draft release notes from merged PRs
@engineer-buddy triage          re-classify this issue
@engineer-buddy help            command table
```

CLI equivalents (what the workflows call):

```bash
# 1. Health-check the brain (no setup needed — it's all keyless)
node src/index.js doctor

# 2. Review a PR
GITHUB_TOKEN=ghp_xxx node src/index.js pr-review \
  --repo lewiseinstein15-Tech/my-app --pr 1 --repo-dir /path/to/repo

# 3. Fix an issue end-to-end (issue → branch → tests → PR)
GITHUB_TOKEN=ghp_xxx node src/index.js fix-issue \
  --repo lewiseinstein15-Tech/my-app --issue 12 --repo-dir /path/to/repo

# 4. Audit dependencies
node src/index.js dep-audit --repo O/R --repo-dir /path/to/repo

# 5. Triage / notes
node src/index.js triage --repo O/R --issue 5
node src/index.js release-notes --repo O/R --since v1.2.0
```

**In CI (the normal path):** copy `deploy/engineer-buddy.yml` into any repo you own — it wires up auto-review, auto-triage, and all comment commands. See that file's header for the 3-line install.

## How a fix works (the write path)

```
@engineer-buddy fix #12
   │
   ▼
PLAN      one LLM call: understanding, plan, files to read
   ▼
EXPLORE   bounded agent (read-only tools) — confirms the root cause
   ▼            low confidence → analysis comment, no patch (never guesses)
EDIT      bounded agent (guarded write tools) — minimal change,
   │            denylist enforced (.env, workflows, keys, lock files),
   ▼            budgets: ≤10 files, ≤600 lines
VERIFY    allowlisted test command (npm test / node --test / pytest …)
   │            fail → feed trace back, repair (≤2 loops)
   ▼            still red → DISCARD everything, comment findings, push nothing
SHIP      branch buddy/fix-issue-12-… → commit → push → PR
                PR body: plan + changes table + verification log
                issue comment links the PR · label buddy:fix-ready
```

**Safety model:** the buddy never pushes to `main`, never merges, never approves, never touches workflows or secret files, and only acts on explicit commands (plus auto-review/triage). Everything it changes lands as a *proposal* PR with a full audit trail. Verification failure = nothing ships.

## What a review looks like

1. **Fetch** — PR metadata, file list, unified diff (GitHub API)
2. **Parse** — per-file added-line maps so inline comments always anchor to real lines
3. **Deterministic scans** (no LLM, cannot be fooled): secret scan, risk heuristics (money/auth surfaces, `.env` commits, `eval()`, disabled TLS)
4. **Agentic context gather** (larger PRs): bounded ReAct loop reads up to 3 related repo files
5. **The review call** — staff-engineer policy: correctness → security → money/data safety → breaking changes → test gaps → error handling. Style nits forbidden.
6. **Normalize** — verdict clamping, line-anchor validation, severity sort, max-findings cap
7. **Publish** — GitHub review (REQUEST_CHANGES on critical; never approves), inline comments, labels, and a footer citing which brain answered and what it cost ($0.00)

## Configuration

Everything lives in `buddy.config.json` (overrides the built-in defaults):

- `gatewayOrder` — failover order; `BUDDY_GATEWAY_ORDER` env overrides
- `gateways.<name>.models` — model IDs or `"auto"` (Kilo discovers free models at runtime, so catalog rotations don't break the bot)
- `review.*` — diff budget, max findings, `excludeFiles` globs (matched files are redacted from diffs sent to gateways)
- `write.*` — fixer budgets: `maxFilesChanged`, `maxLinesChanged`, `requireTestsPass`, `maxRepairLoops`, `commitIdentity`
- `audit.maxAdvisories` — how many advisories the brain triages per run
- `handle` — the comment trigger string (default `@engineer-buddy`)

## Design guarantees

- **Zero npm dependencies** — pure Node ≥20 built-ins. Nothing to install, no supply-chain surface, cold start in milliseconds.
- **Never blocks CI** — any failure posts a comment and exits 0; the buddy is a colleague, not a gatekeeper.
- **No loop risk** — bot authors/drafts skipped; commands require the handle prefix; bots never respond to themselves.
- **Shell allowlist** — the verify phase can only run tests/linters/audits, never arbitrary commands (pipes, redirects, network tools all rejected).
- **Privacy-conscious** — only PR diffs (plus bounded repo context) leave the machine; excluded globs never leave it; nothing is stored anywhere.

## Roadmap

**Full gap checklist vs Claude Code — tools, MCP, subagents, plugins, hooks, and beyond: [CHECKLIST.md](CHECKLIST.md)** (tick items off as they ship)

The tool registry + agent core are generic (see `docs/ARCHITECTURE.md`):

1. ~~PR reviewer~~ ✅
2. ~~Issue fixer (issue → tested PR)~~ ✅
3. ~~Dependency auditor~~ ✅
4. ~~Issue triage~~ ✅
5. ~~Release notes~~ ✅
6. ~~Terminal coding agent (Buddy Code + Harness² harness)~~ ✅ v0.3
7. ~~Complete Claude Code-style interface (diff previews, interrupt, todo plans, /cost, /review, exports)~~ ✅ v0.4
8. **Cross-repo chore runner** — "apply this migration to all my repos" (next)
9. **Local Ollama tier** — fully offline mode for private repos

Full design rationale, failover state machine, tool taxonomy, and the safety model: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
