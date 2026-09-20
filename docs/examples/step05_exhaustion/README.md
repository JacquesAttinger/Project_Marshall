# Recorded run — exhaustion path, 2026-09-20

<!-- Last edited: 2026-09-20 12:35 CDT -->

**TLDR:** A plan that contradicts itself (`version` must be `2.0.0`, must come from `api.__version__`, and `api.__version__` must stay `0.1.0`) was run with `maxFixCycles: 1`.
The agent built the sensible reading, filed both contradictions as followups, opened the PR, and after one review cycle with open spec findings ended with `review_exhausted` and a draft PR whose body starts with `## Still failing`.

| | |
|---|---|
| Issue | `CHE-0` (no real issue; the URL in the plan is a placeholder) |
| PR | https://github.com/dvairus/ChessBuddy/pull/37 — draft, closed after the run |
| Outcome | `review_exhausted`, `reason`: `1 cycles; still open: GET /health must return version 2.0.0 but api.__version__ is 0.1.0 and the bump is out of scope` |
| Slot | 1 (`COMPOSE_PROJECT_NAME=marshall-1`, `API_HOST_PORT=8100`; no Compose needed) |
| Launch | `MARSHALL_CONFIG=<config with maxFixCycles 1> bun scripts/launch-implement.ts --cwd <scratch worktree> --plan docs/health_version_2_plan.md --issue CHE-0 --slot 1 --watch` |
| Wall clock | 5 min 50 s from launch to `SessionEnd` |

Files here: `plan.md` (the contradictory plan), `implement.json` (final status), `pr_body.md` (the draft PR body as the skill left it).

## What it showed

- Preflight did not bail out as `blocked`: the agent judged the plan workable under one reading, wrote both contradictions into `followups` before touching code, and moved on.
- The review's Spec pass flagged requirement 1 as unmet and requirement 3 as contradictory; the bug hunt found no `CONFIRMED` defects and two `PLAUSIBLE` notes (a tautological test, an outdated README line), which landed in `reviewNotes`.
- Findings the agent judged wrong went into `reviewNotes` with a `disputed:` prefix, as the skill says, and into the `## Still failing` section.
- The launcher's watcher died mid-run with `SQLITE_BUSY`: a second Marshall process was writing the same `marshall.db`. `openDb()` now sets `busy_timeout = 5000`, and `launch-implement.ts --attach <runId>` re-attached a watcher that stopped the session when the agent finished.
