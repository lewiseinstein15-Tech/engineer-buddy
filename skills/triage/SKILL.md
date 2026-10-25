---
name: triage
description: Classify and prioritize an issue or bug report. Use when the user pastes an issue and asks how to label it, prioritize it, or what to ask the reporter.
allowed-tools: fs_read, fs_search, fs_list, todo
---

# Skill: triage

Classify an issue the way a maintainer would in their first 60 seconds.
Read-only: you never post to GitHub yourself — hand the labels and reply to
the user to post.

## Classify

- **type**: `bug` | `feature` | `question` | `docs` | `security` | `chore`
- **priority**: `p0` (production down / money lost / data at risk) · `p1`
  (core flow broken, no workaround) · `p2` (annoyance or edge case) ·
  `p3` (nice to have)
- **labels**: 2-4 lowercase, kebab-case, matching the repo's existing label
  style (check recent issues or `.github/labeler` config if present).

## First response

Write 2-5 sentences that: acknowledge the reporter, state what you understood,
and either (a) ask the ONE most useful clarifying question when information is
missing (exact version, repro steps, expected vs actual), or (b) say what
happens next. Set `needs_more_info` accordingly.

Before classifying as `bug`, do a quick reality check in the code (fs_search
the symbol/flow involved) — reports that describe intended behavior are
`question`, not `bug`. Security reports get `security` + `p0`/`p1` and a
request for details in private, never in public comments.

## Output

A compact block: `type · priority · labels` + the suggested first response.
