# Engineer Buddy 🤖🔧

**A keyless AI engineering agent. Zero API keys. Zero monthly cost.**
**Buddy Code** — a Claude Code-style coding agent in your terminal (chat, explore, edit, run, verify) — **plus five GitHub skills** (autonomous PR review, issue → fix PR, dependency auditing, issue triage, release notes).

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

## Buddy Code — the terminal coding agent (v0.3)

Like Claude Code, but keyless and $0. Run it in any repo:

```bash
buddy                    # interactive session in the current directory
buddy -p "fix the flaky login test and run the suite"   # one-shot, autonomous
buddy init               # scaffold the harness (.buddy/harness/) in a repo
```

You type a task. Buddy lists/reads/searches the code, edits files (with your approval per write, or `/yolo`), runs tests and commands, iterates until it works, and reports what changed and what it verified. Slash commands: `/help /learn /memory /experience /tools /yolo /status /new /sessions /quit`.

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

### Safety model (terminal mode)

- **Approval gates** — writes, edits, and shell commands ask `[y]es / [n]o / [a]lways` unless you `/yolo`. One-shot mode (`-p`) is autonomous; add `--safe` to deny all writes.
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

The tool registry + agent core are generic (see `docs/ARCHITECTURE.md`):

1. ~~PR reviewer~~ ✅
2. ~~Issue fixer (issue → tested PR)~~ ✅
3. ~~Dependency auditor~~ ✅
4. ~~Issue triage~~ ✅
5. ~~Release notes~~ ✅
6. ~~Terminal coding agent (Buddy Code + Harness² harness)~~ ✅ v0.3
7. **Cross-repo chore runner** — "apply this migration to all my repos" (next)
8. **Local Ollama tier** — fully offline mode for private repos

Full design rationale, failover state machine, tool taxonomy, and the safety model: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
