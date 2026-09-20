**TLDR:** `GET /health` now tells you which version of the API is running. The version comes from `api.__version__`, and the FastAPI app object reads it from the same place, so there is one source for the string inside the package.

## What changed

- `services/api/src/api/main.py`: `/health` returns `{"status": "ok", "version": "0.1.0"}` with the version read from `api.__version__`; `FastAPI(...)` gets `version=__version__` instead of a literal.
- `services/api/tests/test_health.py`: asserts the new body against `api.__version__` and that `app.version` matches the package.

## Hand-off

_Filled in by the hand-off step._

Closes https://linear.app/chessbuddy/issue/CHE-5/health-endpoint-reports-the-api-version

