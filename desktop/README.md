# Buddy Desktop

A desktop application for **[engineer-buddy](https://github.com/lewiseinstein15-Tech/engineer-buddy)** — the keyless, $0/month, Claude Code-style terminal coding agent, taken out of the terminal and into a real desktop UI. Warm, light, chat-shaped: every step buddy takes becomes a block in the conversation, and the raw stream docks top-right as the inspector.

**The agent is the repo.** Nothing here re-implements Buddy: every task is executed by the real engine (`node src/index.js -p "<task>" -o stream-json`), with its real brain failover chain, its real tools, its real permissions, its real event log. The desktop app is the window; Buddy is the agent.

## What you get

**The conversation (chat like the best agent UIs, buddy's own skin):**
- **Thinking lines, interleaved** — the engine's own decision rationales (its `why` per step, from `.buddy/events.jsonl`) stream into the chat as collapsible **Thinking ▶** lines between the actions, with the gateway and model that reasoned them. Click to open one; the newest stays open while it works, then folds.
- **Command cards that collapse** — every tool call is a one-line card (icon · tool · what it did · `DONE · exit 0 · 0.2s` status chip · chevron). Click the chevron to open the full output. Bash/git amber, file reads teal, file writes purple, web blue.
- **A live To-dos card** — when Buddy plans with its real `todo` tool, a collapsed `☰ To-dos · 2/3 ▶` card appears and updates in place: ✓ done, ◐ active, ○ pending. Click to expand the checklist.
- **The answer card** — Buddy's final reply lands in its own titled card (**✻ buddy's answer**) so it can't be missed between the tool cards, rendered as real markdown: headings, bold, lists, tables, `inline code`, fenced code blocks with a working copy button. A relay that cuts the reply mid-sentence can't leak raw `**` onto the screen — unmatched markers are stripped and code spans are protected first. Cards are for commands; the answer gets the stage.
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

From the repo checkout (this folder lives at `desktop/` inside it):

```bash
git clone https://github.com/lewiseinstein15-Tech/engineer-buddy.git
cd engineer-buddy
./desktop/start.sh               # or: node desktop/server.mjs
# open http://127.0.0.1:7822
```

Or as a standalone folder sitting next to an `engineer-buddy` checkout:

```bash
cd buddy-desktop
./start.sh
```

Point the workspace at any git project you want Buddy to work in (`BUDDY_WORKSPACE` defaults to `/tmp/buddy-workspace`):

```bash
BUDDY_WORKSPACE=/path/to/your/project ./desktop/start.sh
```

The engine is resolved from (in order): `ENGINEER_BUDDY_PATH`, an `engineer-buddy/` checkout sitting next to this folder, then the repo checkout this folder is part of.

## Put it in your app launcher (own icon, own window)

Three routes — none adds a dependency; pick one per OS:

**Chrome / Edge "Install app" (PWA — any OS):** with the app open, click the install icon in the address bar (Chrome: `Install`; Edge: Apps → *Install this site as an app*). **Buddy Desktop** lands in the app launcher / Start menu with its own window and its own icon. The app ships `manifest.webmanifest`, the icon set, and a pass-through service worker — nothing is cached and no offline mode is faked: the app IS a local server.

**Linux (`.desktop` entry):**

```bash
./desktop/install-launcher.sh        # from the repo checkout
```

GNOME Activities / the KDE menu / dock launchers now list **Buddy Desktop**. Launching it boots the server if it is not running and opens the UI in its own chromeless window (Chromium `--app` mode, `StartupWMClass=buddy-desktop` so the taskbar groups it). Remove it again with `./desktop/uninstall-launcher.sh`.

**macOS (`.app` bundle):**

```bash
./desktop/install-launcher-mac.sh    # builds ~/Applications/Buddy Desktop.app
```

Buddy Desktop appears in Launchpad and Spotlight with its own icon (a committed `AppIcon.icns` — no code signing, so Gatekeeper asks once on first launch).

**Windows (Start menu):** run `powershell -File desktop\install-launcher.ps1`. It creates the **Buddy Desktop** Start-menu shortcut (icon `app-icons\buddy.ico`) pointing at `buddy-desktop.cmd` — server booted if needed, then an Edge/Chrome `--app` window.

The launchers use a Chromium-family browser for the chromeless window (any of Chrome / Chromium / Edge / Brave — Edge ships with Windows); without one they open a normal tab. The server itself never needs a browser.

## Files

| File | Role |
| --- | --- |
| `server.mjs` | Local server (127.0.0.1:7822): spawns the real engine per task, forwards its `stream-json` over SSE, enriches it with `.buddy/events.jsonl` (`why`, gateway, model), parses `todo` plans, persists replayable sessions, serves workspace git state, GitHub account connect/commit/push, and brain-config endpoints |
| `app.html` | The desktop UI — the conversation: thinking lines, collapsible tool cards, to-dos card, the rendered answer card, diff card, sessions/git/settings panels, files picker, inspector, composer |
| `manifest.webmanifest` + `sw.js` | PWA identity: the metadata and icons behind the browser's "Install app" (own launcher entry, own window, own icon); the service worker is a pass-through — nothing cached, no fake offline |
| `app-icons/` | The launcher icon set: rounded + maskable PNGs (512/192/32), apple-touch 180, Windows `buddy.ico`, macOS `AppIcon.icns` |
| `launch.sh` | Boots the server if it is not running, then opens the UI in its own chromeless app window (Chromium `--app`, macOS `open`, plain-tab fallback) |
| `install-launcher.sh` / `uninstall-launcher.sh` | Install / remove the Linux `.desktop` launcher entry (app launcher, own icon) |
| `install-launcher-mac.sh` | Build `~/Applications/Buddy Desktop.app` (macOS Dock / Launchpad / Spotlight) |
| `buddy-desktop.cmd` + `install-launcher.ps1` | Windows launcher + Start-menu shortcut |

## Modes

- **yolo unchecked (safe)** — Buddy's one-shot mode denies risky tools; reads/planning still work.
- **yolo checked** — Buddy may run commands (`node test.js`, `git …`) and edit files, exactly like the terminal's `--yolo`.

One task runs at a time — same as Buddy itself.

## Provenance

The engine this app wraps is the public repo <https://github.com/lewiseinstein15-Tech/engineer-buddy> (v0.69.0 at packaging time). The app was built by the agent working for Lewis; it adds a desktop UI on top of Buddy's documented one-shot `stream-json` interface and changes no engine code — provider overrides ride the engine's own `buddy.config.json` mechanism, and the "Thinking" lines are Buddy's own logged rationales.
