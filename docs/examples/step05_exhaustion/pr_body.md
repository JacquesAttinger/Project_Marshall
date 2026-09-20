## Still failing

Review cycle 1 of 1 ended with open spec findings:

1. Plan req 1 (`GET /health` returns `"version": "2.0.0"`) is not met. `api.__version__` is `0.1.0` and the plan puts the bump out of scope, so the endpoint reports `0.1.0`. Needs a ruling from the plan owner.
2. Plan req 3 (test asserts the literal `"2.0.0"`) is disputed: it contradicts plan req 2 (no literal version string in the test) and would fail today for the reason in 1.
3. `FastAPI(version=__version__)` flagged as scope: kept, because plan req 2 says no literal version string appears in `main.py`.

**TLDR:** `GET /health` now also returns a `version` field. The value comes from `api.__version__`, so the endpoint and the FastAPI app metadata report the same version without a hard-coded string. The test checks the body against the same symbol.

## What changed

- `services/api/src/api/main.py`: `GET /health` returns `{"status": "ok", "version": api.__version__}`; the FastAPI `version=` argument reads `__version__` instead of a literal.
- `services/api/tests/test_health.py`: asserts the full body, with `version` compared to `api.__version__`.
- Note: `api.__version__` is `0.1.0` today. The plan expects `2.0.0` but puts the bump out of scope, so the endpoint reports `0.1.0` until the release PR lands.

## Hand-off

_Filled in by the hand-off step._

Closes https://linear.app/chessbuddy/issue/CHE-0/scratch-exhaustion-test


