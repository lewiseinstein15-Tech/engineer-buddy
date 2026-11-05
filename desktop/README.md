# Buddy Desktop

A desktop application for **[engineer-buddy](https://github.com/lewiseinstein15-Tech/engineer-buddy)** — the keyless, $0/month, Claude Code-style terminal coding agent, taken out of the terminal and into a real desktop UI. Warm, light, chat-shaped: every step buddy takes becomes a block in the conversation, and the raw stream docks top-right as the inspector.

**The agent is the repo.** Nothing here re-implements Buddy: every task is executed by the real engine (`node src/index.js -p "<task>" -o stream-json`), with its real brain failover chain, its real tools, its real permissions, its real event log. The desktop app is the window; Buddy is the agent.

## What you get

**The conversation (chat like the best agent UIs, buddy's own skin):**
- **Thinking lines, interleaved** — the engine's own decision rationales (its `why` per step, from `.buddy/events.jsonl`) stream into the chat as collapsible **Thinking ▶** lines between the actions, with the gateway and model that reasoned them. Click to open one; the newest stays open while it works, then folds.
- **Command cards that collapse** — every tool call is a one-line card (icon · tool · what it did · `DONE · exit 0 · 0.2s` status chip · chevron). Click the chevron to open the full output. Bash/git amber, file reads teal, file writes purple, web blue.
- **A live To-dos card** — when Buddy plans with its real `todo` tool, a collapsed `☰ To-dos · 2/3 ▶` card appears and updates in place: ✓ done, ◐ active, ○ pending. Click to expand the checklist.
- **Plain flowing answers** — Buddy's final reply renders as real text in the thread (markdown: headings, bold, lists, `inline code`, fenced code blocks with a copy button), not boxed in a card. Cards are for commands; words are words.
- **Narration while it works** — a shimmer bar and a breathing ✦ spark tell you what Buddy is doing right now ("routing — planning step, medium effort · kilo → llm7", "ran fs_write — app.js", "updating the plan — 1/3 done"), with a ticking `t+Ns` timer, ending in `✓ run finished — exit 0 · 19.1s · 3 tool calls`.
- **The files button** — 📎 opens the workspace file picker; what you attach becomes an `@mention` line in the real prompt, so Buddy reads those files first.
- **The diff card** — the patch Buddy left in the workspace, colored and collapsible, straight from `git diff` after each run.
- **The inspector** — the raw `stream-json` events (including stderr), docked top-right.

**Sessions:** every finished run is persisted server-side (`.buddy-desktop/sessions/*.json`). The **⧉ sessions** panel lists them; click one to replay the whole conversation, **⟲ live** returns to the conversation, and **＋ New session** clears the thread and starts fresh.

**Providers & models (⚙ settings):** the brain is a failover chain; the panel shows the engine's defaults (`kilo → llm7 → pollinations → duckai`) untouched. Reorder it, disable gateways, pin a model per gateway — or add a **custom provider**: any OpenAI-compatible endpoint (base URL + API key + model) rides the engine's `kilo` slot (`POST {base}/v1/chat/completions`, Bearer auth), all passed to the engine as a `--config` file + `BUDDY_GATEWAY_ORDER` — no engine code changed. Applies from the next run; **Reset to engine defaults** restores stock.

**Git & GitHub (⎇ git):** connect your GitHub account with a personal access token (verified against `api.github.com/user`, stored `0600` locally, never logged), see branch / dirty files / remote at a glance, **Commit all…**, **Push to GitHub** (the token is injected into the HTTPS push URL only for the push), or **Create repo & push** straight to your account.

## Requirements

- Node.js ≥ 20 (same as engineer-buddy — no other dependencies, zero npm installs)
- A checkout of the `engineer-buddy` repo

## Run it

```bash
cd buddy-desktop
./start.sh                       # workspace defaults to /tmp/buddy-workspace
# or:
BUDDY_WORKSPACE=/path/to/your/project ./start.sh
```

Then open **http://127.0.0.1:7822**.

The engine is resolved from (in order): `ENGINEER_BUDDY_PATH`, an `engineer-buddy/` checkout sitting next to this folder. `BUDDY_WORKSPACE` defaults to `/tmp/buddy-workspace` — point it at any git project.

## Files

| File | Role |
| --- | --- |
| `server.mjs` | Local server (127.0.0.1:7822): spawns the real engine per task, forwards its `stream-json` over SSE, enriches it with `.buddy/events.jsonl` (`why`, gateway, model), parses `todo` plans, persists replayable sessions, serves workspace git state, GitHub account connect/commit/push, and brain-config endpoints |
| `app.html` | The desktop UI — the conversation: thinking lines, collapsible tool cards, to-dos card, plain-text answers, diff card, sessions/git/settings panels, files picker, inspector, composer |

## Modes

- **yolo unchecked (safe)** — Buddy's one-shot mode denies risky tools; reads/planning still work.
- **yolo checked** — Buddy may run commands (`node test.js`, `git …`) and edit files, exactly like the terminal's `--yolo`.

One task runs at a time — same as Buddy itself.

## Provenance

The engine this app wraps is the public repo <https://github.com/lewiseinstein15-Tech/engineer-buddy> (v0.69.0 at packaging time). The app was built by the agent working for Lewis; it adds a desktop UI on top of Buddy's documented one-shot `stream-json` interface and changes no engine code — provider overrides ride the engine's own `buddy.config.json` mechanism, and the "Thinking" lines are Buddy's own logged rationales.
