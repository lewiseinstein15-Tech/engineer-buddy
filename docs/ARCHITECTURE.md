# Engineer Buddy — Architecture

> Status: v0.1 — PR reviewer shipped. This document is the full engineering design: the brain chain, the agent skeleton, the complete tool taxonomy, and the deployment topology. Everything here runs at **$0/month with zero API keys**.

---

## 1. System overview

```
                        ┌──────────────────────────────────────────────┐
                        │              TARGET REPO (efoootball)        │
                        │                                              │
                        │  PR opened/sync ─┐                           │
                        │  "@engineer-buddy│                           │
                        │    review" ──────┤                           │
                        └──────────────────┼───────────────────────────┘
                                           │ triggers
                        ┌──────────────────▼───────────────────────────┐
                        │         GitHub Actions (ubuntu-latest)       │
                        │   engineer-buddy.yml — $0 free-tier runner   │
                        │                                              │
                        │   GITHUB_TOKEN (built-in, no secrets)        │
                        │   + clone of OpenAImakers/engineer-buddy     │
                        └──────────────────┬───────────────────────────┘
                                           │ node src/index.js pr-review
              ┌────────────────────────────▼──────────────────────────────┐
              │                    ENGINEER BUDDY (Node ≥20, 0 deps)      │
              │                                                           │
              │   ┌─────────────────── ✋ TOOLS ─────────────────────┐    │
              │   │ github.*   get_pull / get_files / get_diff /    │    │
              │   │            create_review / add_labels           │    │
              │   │ repo.*     read_file / list_files / search_code │    │
              │   │ sec.*      scan_secrets / scan_risks (regex,    │    │
              │   │            deterministic — cannot be fooled)    │    │
              │   └────────────────────────▲───────────────────────────┘    │
              │                            │ observations                  │
              │   ┌────────────────────────┴───────────────────────────┐   │
              │   │              🦴 SKELETON (agent core)              │   │
              │   │  bounded ReAct loop: plan → tool call (strict      │   │
              │   │  JSON protocol) → observe → … → finish             │   │
              │   │  + review pipeline: parse → scan → gather →        │   │
              │   │  review → normalize → publish                      │   │
              │   └────────────────────────▲───────────────────────────┘   │
              │                            │ messages                     │
              │   ┌────────────────────────┴───────────────────────────┐   │
              │   │                   🧠 BRAIN (keyless)               │   │
              │   │                                                    │   │
              │   │   GatewayRouter — ordered failover engine          │   │
              │   │   1. Kilo (OpenRouter-compat, Bearer anonymous)    │   │
              │   │   2. llm7.io (token "unused")                      │   │
              │   │   3. Pollinations (anonymous tier)                 │   │
              │   │   4. Duck.ai (best-effort unofficial)              │   │
              │   │   5. Ollama local (optional offline backstop)      │   │
              │   │   circuit breaker · Retry-After parking · 2 sweeps │   │
              │   └────────────────────────────────────────────────────┘   │
              └────────────────────────────┬──────────────────────────────┘
                                           │ posts
                        ┌──────────────────▼───────────────────────────┐
                        │   GitHub review: verdict + inline comments   │
                        │   + labels (buddy:critical / changes / clean)│
                        └──────────────────────────────────────────────┘
```

## 2. The brain: keyless-only provider chain

### 2.1 Design requirements

1. **Keyless only** — no signup walls, no credit cards, no tokens to leak or rotate.
2. **Never fails** — the chain as a whole must tolerate any single provider dying, being rate-limited, or rotating its model catalog.
3. **Never wedged on quota** — a rate-limited provider must be *parked*, not hammered.

### 2.2 Providers (all verified live 2026-10-25)

| # | Provider | Endpoint | Auth | Free capacity | Failure mode handled |
|---|----------|----------|------|---------------|----------------------|
| 1 | Kilo Gateway (kilo.ai — the gateway behind the `openkilo` npm plugin) | `https://api.kilo.ai/api/openrouter/v1/chat/completions` | `Authorization: Bearer anonymous` | 13 `:free` models, ~200 req/h/IP; catalog auto-discovered from `/v1/models` | model rotation → runtime re-discovery |
| 2 | llm7.io | `https://api.llm7.io/v1/chat/completions` | `Authorization: Bearer unused` (literal) | several free models incl. `codestral-latest` | `model_unavailable` → walk model list |
| 3 | Pollinations | `https://text.pollinations.ai/openai` | none (anonymous tier) | GPT-OSS-20B, ~1 req/30s/IP | `402 FREE_LIMIT` → park for its stated `Retry-After` |
| 4 | Duck.ai (DuckDuckGo) | `https://duckduckgo.com/duckchat/v1/chat` | keyless `x-vqd-4` handshake | GPT-4o-mini unofficial | JS-challenge/403 → skipped in ~0.1s |
| 5 | Ollama (local, optional) | `http://127.0.0.1:11434/api/chat` | none | any local model | offline backstop for air-gapped/dev use |

Deliberately **excluded** (require keys or violate constraints): Groq, Gemini API, HuggingFace Inference, OpenRouter direct, GitHub Models (retired Jul 2026), Hack Club AI (now key-walled).

### 2.3 Failover state machine (per gateway)

```
            ┌──────────┐  success
            │  CLOSED  ├──────────────►  usable, reset failures
            │ (usable) │
            └────┬─────┘
                 │ failure
                 ▼
        failures < threshold ? ── yes ──► stay closed, count++
                 │ no
                 ▼
            ┌──────────┐  cooldown elapsed
            │   OPEN   ├──────────────►  half-open probe: one real call
            │ (parked) │                     └─ success → CLOSED
            └────┬─────┘                      └─ failure → OPEN again
                 │ 429/402 with Retry-After
                 ▼
        park for EXACT retry window (not the generic cooldown)
```

Router sweep: gateways in configured order → skip open circuits → on total failure, sweep again (2 round trips). If every circuit is open during a rate-limit cascade, the router sleeps for the shortest park window and retries. `ALL_GATEWAYS_FAILED` is surfaced only after the full sweep — and the skill layer converts even that into a polite PR comment (exit 0, CI unaffected).

### 2.4 Why these three ranks first

- **Kilo** ranks #1 by explicit product decision (the user-specified "OpenKilo") and on merit: 13 free models with runtime discovery means the catalog can rotate daily without breaking us; `nemotron-3-ultra-550b` is the strongest free model we verified.
- **llm7** is ranked #2 because `codestral-latest` is a *coding-specialized* model — best quality-per-call for diffs.
- **Pollinations** #3: verified reliable but the 1 req/30s anonymous pacing makes it a fallback, not a primary, for bursty CI usage.
- **Duck.ai** #4: unofficial and the handshake breaks periodically; it is free insurance, never a dependency.

## 3. The skeleton: agent core

### 3.1 Loop

`runAgent()` (src/agent/agent.js) is a bounded ReAct loop with a **strict JSON tool protocol** (chosen over function-calling because small free models follow explicit JSON schemas far more reliably):

```
system: protocol + tool descriptions + skill persona
  ↓ loop (maxSteps, default 4)
model → {"tool":"read_file","args":{"path":"src/x.js"}}
  ↓
tool runs → observation string
  ↓ appended as user message
model → … or {"tool":"finish","result":{…}}
```

Protocol violations terminate the loop cleanly (the caller degrades gracefully). Every step is logged with model/gateway/latency for the review footer.

### 3.2 The review pipeline (skill #1)

```
get PR ──► skip rules (bots / drafts / WIP)
   │
   ▼
parse unified diff ──► per-file added-line maps  ◄── inline comments anchor here
   │
   ▼
deterministic scans ──► secrets + risks (regex — LLM cannot skip these)
   │
   ▼ [if churn ≥ threshold]  agentic deep-gather (≤3 repo files via runAgent)
   │
   ▼
one structured review call → strict JSON contract
   │
   ▼
normalizeReview() ──► clamp enums · validate line anchors against real diff ·
│                     severity sort · cap findings · quarantine bad anchors
▼
mapToGitHubReview() ──► REQUEST_CHANGES iff critical (config) else COMMENT
                        (never APPROVE — the human team lead decides)
```

**Determinism + LLM separation is the core quality trick:** the LLM does judgment; regexes do facts; normalization enforces honesty. Free-model hallucinations (invented paths, out-of-range lines, verdicts outside the enum) are caught and quarantined, never posted.

### 3.3 Why not OpenHands / SWE-agent / Aider?

Evaluated for "best real-engineering performance, not benchmarks":

| Candidate | Verdict for this use case |
|---|---|
| **OpenHands** | Strongest open agent overall, but assumes a Docker sandbox + heavy runtime — wrong shape for a $0 Actions bot doing focused reviews |
| **SWE-agent (Princeton)** | Best ACI design lessons (tight tool interfaces, structured outputs) — **adopted its philosophy** in the JSON tool protocol |
| **Aider** | Best-in-class edit formats, but it's a pair-programmer, not an autonomous reviewer |
| **LangGraph / CrewAI** | Orchestration frameworks; we'd still write every tool — pure overhead for one skill |
| **Custom (chosen)** | ~600 lines, zero deps, every design decision serves review quality + keyless failover. Borrowed: SWE-agent's ACI discipline, OpenHands' event loop, Aider's "context is king" (repo reads before judging) |

## 4. Complete tool taxonomy (engineering agent, everything)

**Shipped in v0.1** = ✅ · **designed, next skills** = ◻

### A. Code intelligence
| Tool | Status | Purpose |
|---|---|---|
| `diff.parse` (added-line maps) | ✅ | anchor comments to real lines |
| `repo.read_file` (capped) | ✅ | agent context gathering |
| `repo.list_files` | ✅ | repo orientation |
| `repo.search_code` (grep/regex) | ✅ | callers/usages of changed symbols |
| AST-aware symbol extraction | ◻ | precise "what exports changed" |
| repo map (Aider-style summaries) | ◻ | large-repo orientation |

### B. Code mutation (future skills)
| Tool | Status | Purpose |
|---|---|---|
| patch/diff apply + branch push | ◻ | test-fixer, auto-patch skills |
| commit + PR creation | ◻ | close the loop on fixes |

### C. Verification
| Tool | Status | Purpose |
|---|---|---|
| run test suite, parse failures | ◻ | test-fixer skill |
| `npm audit` / lockfile diff | ◻ | dependency auditor skill |
| lint runner | ◻ | style gate (LLM freed from nits) |
| coverage delta | ◻ | test-gap quantification |

### D. Git & GitHub
| Tool | Status | Purpose |
|---|---|---|
| `get_pull / get_files / get_diff` | ✅ | PR materialization |
| `create_review` (event + inline) | ✅ | publish verdict |
| `add_labels` | ✅ | triage state |
| `create_comment` (fallback) | ✅ | degrade gracefully when reviews are blocked |
| issue read/comment/close | ◻ | triage skill |
| release notes from merged PRs | ◻ | release skill |

### E. Security & safety (deterministic layer)
| Tool | Status | Purpose |
|---|---|---|
| `scan_secrets` (10 families) | ✅ | AWS/GH/Slack/Google/Stripe/Paystack/npm tokens, private keys, JWTs, DB URIs |
| `scan_risks` heuristics | ✅ | money/auth/migration surfaces, dep changes, `.env`, `eval`, disabled TLS |
| exclude-file redaction (globs) | ✅ | `.env*`, `*.pem`, `*.key` never leave the runner |
| loop protection (skip bots/drafts) | ✅ | bot reviews PRs, never its own triggers |
| never-approve policy | ✅ | human lead owns merge decisions |

### F. Knowledge & memory
| Tool | Status | Purpose |
|---|---|---|
| run-scoped working memory | ✅ | context pack built per review |
| persistent memory (per-repo learnings) | ◻ | "we fixed this in #42" recall |
| web search/fetch | ◻ | docs lookup for unfamiliar APIs |

### G. Orchestration
| Tool | Status | Purpose |
|---|---|---|
| `GatewayRouter` failover + breaker | ✅ | the brain never wedges |
| bounded ReAct loop | ✅ | cost/latency ceilings per run |
| skill registry (CLI dispatch) | ✅ | pr-review / doctor / ask |
| concurrency guards (workflow level) | ✅ | one review per PR at a time |

## 5. Deployment topology

```
github.com/OpenAImakers/engineer-buddy     github.com/OpenAImakers/efoootball
┌──────────────────────────────────┐       ┌─────────────────────────────────┐
│ the agent itself                 │       │ the product (React + Supabase)  │
│ src/ + tests + workflows         │◄──────│ .github/workflows/              │
│ self-dogfooding on its own PRs   │ clone │   engineer-buddy.yml (thin shim)│
│ CI: node --test + doctor         │       │ triggers: PR + @engineer-buddy  │
└──────────────────────────────────┘       └─────────────────────────────────┘
```

Separation is deliberate: buddy updates ship on their own cadence and never require touching the product repo; the product repo gets one ~50-line workflow file and zero dependencies. `vars.BUDDY_REPO` (optional repo variable) redirects the clone source without code changes.

## 6. Failure containment (what happens when things break)

| Failure | Containment |
|---|---|
| One gateway down/rate-limited | circuit breaker parks it; next gateway takes over; parked ones rejoin after cooldown |
| All gateways down | bot comments on the PR explaining the outage; exits 0; CI unaffected; human review proceeds |
| Model returns garbage JSON | `extractJson` balanced scanner + normalize quarantine; bad findings never post |
| Hallucinated file/line anchors | validated against the real parsed diff; displaced to the summary body |
| Secrets in the diff | deterministic scan flags them regardless of model output; forces REQUEST_CHANGES |
| Bot triggered by its own comment | author-type and comment-content guards in the workflow `if` |
| Runaway agent loop | maxSteps (4) + per-call timeouts (150s) + Actions job ceiling |
| Review API 403 (fork PRs) | automatic fallback to a plain issue comment |

## 7. Cost accounting

| Resource | Rate | Typical PR review | Monthly (30 PRs) |
|---|---|---|---|
| GitHub Actions (public repo) | free | 1 job ≈ 1 min | $0 |
| LLM calls (keyless) | free | 2–6 calls | $0 |
| **Total** | | | **$0.00** |
