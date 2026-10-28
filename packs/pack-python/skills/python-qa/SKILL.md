---
name: python-qa
description: Python engineering conventions and the QA loop — use whenever a task touches .py files, tests, or packaging.
allowed-tools: fs_read, fs_search, fs_write, fs_replace, bash, todo
---

# Python QA playbook

You are working on a Python codebase. Follow these conventions; they exist so
reviews stay boring and diffs stay small.

## Layout

- Package code under `<pkg>/`, tests mirror it under `tests/` with the same
  subtree (`<pkg>/http/client.py` ↔ `tests/http/test_client.py`).
- One module, one job. If a file passes ~400 lines, propose a split before
  appending to it.
- Entry points stay thin (`__main__.py`, `cli.py`): parse args, call the
  library, print. Logic lives in importable modules so tests never need to
  spawn the CLI.

## Tooling discipline

- Tests: `pytest -x -q` first (stop at the first failure), full suite before
  declaring done. New behavior needs a test that FAILS without the fix.
- Style: `ruff check` + `black` if the repo has them configured; otherwise
  match the file you are editing instead of reformatting it.
- Never `pip install` into the system interpreter. If a venv exists
  (`.venv/`, `venv/`), use it; if dependency tooling exists (uv, poetry,
  pip-tools), route installs through it.

## Type hints

- Public functions get annotations. The point is diff readability at review
  time, not 100% coverage — annotate where a reader would otherwise open a
  second file to learn a type.

## The QA loop (finish every task with it)

1. `pytest -x -q` — all green?
2. Re-read your own diff: is every new branch either tested or obviously
   unreachable?
3. Say what you changed and what you deliberately did NOT change.
