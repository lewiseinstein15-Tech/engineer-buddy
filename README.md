# Engineer Buddy 🤖🔧

**A keyless AI engineering agent for GitHub. Zero API keys. Zero monthly cost. First skill: autonomous PR review before your team lead ever opens the PR.**

```
$ node src/index.js doctor

┌────────────────┬───────┬────────┬──────────────────────────────────────────┐
│ gateway        │ alive │  time  │ model / note                             │
├────────────────┼───────┼────────┼──────────────────────────────────────────┤
│ kilo           │  ✅    │   1.6s │ nvidia/nemotron-3-ultra-550b-a55b:free   │
│ llm7           │  ✅    │   0.8s │ codestral-latest round-trip OK           │
│ pollinations   │  ✅    │   7.8s │ gpt-oss-20b round-trip OK                │
│ duckai         │  ❌    │   0.1s │ best-effort (unofficial API)             │
└────────────────┴───────┴────────┴──────────────────────────────────────────┘

3/4 gateways alive. Chain never fails while ≥1 is up.
```

## Why this exists

I needed a serious pre-review gate: every PR gets an engineering-grade review *before* a human ever opens it. The constraints that shaped everything:

| Constraint | How it's met |
|---|---|
| **$0/month, forever** | GitHub Actions free tier + keyless LLM gateways |
| **No API keys, ever** | Every gateway in the chain is keyless (anonymous tier) |
| **Never fails, never stuck on quota** | 4 independent gateways + circuit breaker + round-trip retries |
| **Serious engineering, not benchmark theater** | Real repo access (agentic file reads), deterministic security scans layered on the LLM, strict output validation |

## The keyless brain chain

All providers verified live on **2026-10-25**. No keys anywhere.

| # | Gateway | Endpoint | Models (free tier) | Notes |
|---|---------|----------|--------------------|-------|
| 1 | **Kilo Gateway** (the "OpenKilo" free tier) | `api.kilo.ai/api/openrouter/v1` | 13 `:free` models, auto-discovered (e.g. `nvidia/nemotron-3-ultra-550b-a55b:free`) | OpenRouter-compatible; `Authorization: Bearer anonymous` |
| 2 | **llm7.io** | `api.llm7.io/v1` | `codestral-latest`, `gpt-oss:20b`, `minimax-m2.7` | anonymous token is the literal string `unused` |
| 3 | **Pollinations** | `text.pollinations.ai/openai` | `openai` → GPT-OSS-20B (tools OK) | anonymous tier ≈ 1 req/30s per IP; bot parks it via `Retry-After` |
| 4 | **Duck.ai** (DuckDuckGo) | `duckduckgo.com/duckchat/v1` | `gpt-4o-mini` | unofficial, best-effort; handshake needs a JS challenge sometimes |
| 5 | **Ollama (local)** — optional | `127.0.0.1:11434` | any local model | offline last resort; disabled by default |

The router fails over in order, opens a circuit breaker after repeated failures, parks rate-limited gateways for their exact `Retry-After`, and re-sweeps the whole chain up to 2 round trips. Reviews only fail if **every** gateway dies simultaneously — and even then the bot posts a polite notice on the PR instead of breaking CI.

## Quickstart

```bash
# 1. Health-check the brain (no setup needed — it's all keyless)
node src/index.js doctor

# 2. Dry-run a review of any PR
GITHUB_TOKEN=ghp_xxx node src/index.js pr-review \
  --repo lewiseinstein15-Tech/my-app --pr 1 --dry-run --repo-dir /path/to/repo

# 3. Post it for real (drop --dry-run)
```

**In CI (the normal path):** the `engineer-buddy.yml` workflow in the target repo does all of this automatically on every `pull_request` event, using the built-in `GITHUB_TOKEN`. See `deploy/engineer-buddy.yml`.

**On-demand re-review:** comment `@engineer-buddy review` on any PR.

## What a review looks like

1. **Fetch** — PR metadata, file list, unified diff (GitHub API)
2. **Parse** — per-file added-line maps so inline comments always anchor to real lines
3. **Deterministic scans** (no LLM, cannot be fooled):
   - secret scan on added lines: AWS/GitHub/Slack/Google/Stripe/Paystack/npm tokens, private keys, JWTs, DB URIs
   - risk heuristics: money/auth/migration surfaces touched, dependency changes, `.env` commits, huge files, `eval()`/`rejectUnauthorized:false` patterns
4. **Agentic context gather** (only for larger PRs): a bounded ReAct loop reads up to 3 related repo files so the review judges the change *in context*, not in isolation
5. **The review call** — one structured prompt to the brain chain with a staff-engineer policy: correctness bugs → security → money/data safety → breaking changes → test gaps → error handling. Style nits are explicitly forbidden.
6. **Normalize** — verdict clamping, line-anchor validation against the real diff, severity sort, max-findings cap. Free models hallucinate; the pipeline refuses to pass that through.
7. **Publish** — a GitHub review (REQUEST_CHANGES on critical, otherwise COMMENT — it never approves; the human decides), inline comments on exact lines, labels (`buddy:critical`, `buddy:changes-requested`, `buddy:clean`), and a footer citing which brain answered, how long it took, and what it cost ($0.00).

## Commands

| Command | What it does |
|---|---|
| `node src/index.js pr-review --repo O/R --pr N [--dry-run] [--repo-dir PATH]` | run the PR reviewer |
| `node src/index.js doctor` | probe every gateway in the chain |
| `node src/index.js ask "question"` | one-off brain query (debug utility) |
| `npm test` | unit tests (zero dependencies, `node:test`) |

## Configuration

Everything lives in `buddy.config.json` (overrides the built-in defaults):

- `gatewayOrder` — failover order; `BUDDY_GATEWAY_ORDER` env overrides
- `gateways.<name>.models` — model IDs or `"auto"` (Kilo discovers free models at runtime, so catalog rotations don't break the bot)
- `review.*` — diff budget, max findings, whether critical ⇒ REQUEST_CHANGES, `excludeFiles` globs (default: `.env*`, `*.pem`, `*.key` — matched files are redacted from the diff sent to gateways)
- `circuitBreaker.*` — failure threshold, cooldown, round trips

## Design guarantees

- **Zero npm dependencies** — pure Node ≥20 built-ins. Nothing to install, no supply-chain surface, cold start in milliseconds.
- **Never blocks CI** — any review failure posts a comment and exits 0; the bot is a pre-filter, not a gatekeeper.
- **No loop risk** — bot authors and drafts are skipped; the bot never approves.
- **Privacy-conscious** — only PR diffs (plus up to 3 gathered repo files) leave the machine; excluded globs never leave it; no PR content is stored anywhere.

## Roadmap skills

The tool registry + agent core are generic (see `docs/ARCHITECTURE.md` for the full 40-tool taxonomy):

1. **PR reviewer** ← shipped
2. **Test fixer** — runs failing suites, reads traces, proposes patches
3. **Dependency auditor** — `npm audit` triage with severity-to-issue mapping
4. **Issue triage** — labels/routes new issues from repo context
5. **Release notes** — changelog drafts from merged PRs

Full design rationale, failover state machine, and tool taxonomy: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
