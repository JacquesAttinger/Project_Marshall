# CHE-5 — Health endpoint reports the API version

<!-- Last edited: 2026-09-20 11:55 CDT -->

**TLDR:** `GET /health` gains a `version` field taken from `api.__version__`, and the FastAPI app object reads its version from the same place.
One small change in `services/api`, one test update.

Issue: https://linear.app/chessbuddy/issue/CHE-5/health-endpoint-reports-the-api-version

## Orientation

- `services/api/src/api/__init__.py` defines `__version__ = "0.1.0"`.
- `services/api/src/api/main.py` builds `FastAPI(title="ChessBuddy API", version="0.1.0")` and serves `GET /health` → `{"status": "ok"}`.
- `services/api/tests/test_health.py` asserts the exact JSON body; `test_api_import.py` asserts `api.__version__`.
- Docker's healthcheck for the api container only checks that `/health` answers; it does not parse the body.

## Requirements

1. `GET /health` returns `{"status": "ok", "version": "0.1.0"}` where the version is `api.__version__`, not a literal.
2. `FastAPI(...)` gets `version=api.__version__` (import it from the package) so the string has one source inside the package.
3. `test_health.py` asserts the new body and that `version` equals `api.__version__`.
4. The `Last edited` stamp at the top of each edited file is updated.

## Likely touched files

- `services/api/src/api/main.py`
- `services/api/tests/test_health.py`

## Verification

- `uv run pytest services/api`
- `uv run ruff check . && uv run ruff format --check . && uv run pyright`
- No Docker Compose needed.

## Decisions made alone

- The return type stays `dict[str, str]`; both values are strings.
- No new dependency and no `importlib.metadata`: the package constant is enough for this issue.

## Out of scope

- The worker service has no HTTP surface; nothing to add there.

## Out of scope found

- `services/api/pyproject.toml` carries the same `0.1.0` string as `api.__version__`. A follow-up could read the version from package metadata (`importlib.metadata.version("chessbuddy-api")`) and drop the constant, so a release bump touches one file.
