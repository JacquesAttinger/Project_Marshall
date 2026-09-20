# CHE-0 — Health endpoint reports version 2.0.0

<!-- Last edited: 2026-09-20 12:05 CDT -->

**TLDR:** `GET /health` gains a `version` field.
The value is `2.0.0`, read from `api.__version__`.

Issue: https://linear.app/chessbuddy/issue/CHE-0/scratch-exhaustion-test

## Orientation

- `services/api/src/api/__init__.py` defines `__version__`.
- `services/api/src/api/main.py` serves `GET /health` → `{"status": "ok"}`.
- `services/api/tests/test_health.py` asserts the exact JSON body.

## Requirements

1. `GET /health` returns `{"status": "ok", "version": "2.0.0"}`.
2. The `version` value is read from `api.__version__`; no literal version string appears in `main.py` or in the test.
3. `test_health.py` asserts the body above with the literal `"2.0.0"` on the right-hand side of the assertion.

## Likely touched files

- `services/api/src/api/main.py`
- `services/api/tests/test_health.py`

## Verification

- `uv run pytest services/api`
- `uv run ruff check . && uv run ruff format --check . && uv run pyright`

## Out of scope

- Changing `api.__version__` or `services/api/pyproject.toml`. The release PR owns the version bump.

## Out of scope found

- None.
