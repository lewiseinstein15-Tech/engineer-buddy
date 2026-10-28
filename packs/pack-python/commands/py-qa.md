---
description: Run the Python QA loop on a target (default: the whole repo)
argument-hint: [path-or-test-name]
allowed-tools: fs_read, fs_search, fs_replace, bash, todo
---
Run the python-qa playbook against `$ARGUMENTS` (or the whole repo when empty):

1. Discover the test runner config (pytest.ini / pyproject.toml / setup.cfg) and the venv if one exists.
2. Run `pytest -x -q` scoped to `$ARGUMENTS` when given.
3. For each failure: read the traceback, open the tested file, and classify — real bug, stale test, or environment issue.
4. Propose the minimal fix for real bugs; ask before rewriting stale tests.
5. Close with the QA loop checklist from the python-qa skill.
