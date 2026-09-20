# CHE-5 — Health endpoint reports the API version

<!-- Last edited: 2026-09-20 15:39 CDT -->

**TLDR:** `GET /health` used to answer only `{"status": "ok"}`, so nobody could tell which build of the API was running.
It now also returns `"version": "0.1.0"`, read from the one version constant in the `api` package, and the FastAPI app object uses that same constant.

## Where to find it

Not UI-reachable.
It is an HTTP endpoint on the API service.
Run `docker compose up --wait` from the repo root, then open http://localhost:8000/health in a browser or run `curl http://localhost:8000/health`.
The same string shows in the OpenAPI docs at http://localhost:8000/docs, in the header next to the title "ChessBuddy API".

## Orientation

- Area: `services/api` is the FastAPI service that the web app will call; today it serves only a health endpoint so the Docker and uv plumbing can be proven.
- Part: `services/api/src/api/main.py` builds the `FastAPI` app object and declares its routes.
- Section: the `health()` function under `@app.get("/health")` is the liveness probe that Docker polls; it returns a small JSON dict.
- The package constant `__version__` lives in `services/api/src/api/__init__.py`, and `services/api/tests/test_health.py` asserts the exact body of `/health`.

## What was wrong and why

The health body was the literal `{"status": "ok"}` and carried no version, so a deploy could not be checked from the outside.
The `FastAPI(...)` constructor also carried its own literal `version="0.1.0"`, separate from `api.__version__`, so the two strings could drift apart on a release bump.

## What the agent did

`main.py` now imports `__version__` from the `api` package, passes it to `FastAPI(...)`, and adds it to the `/health` response as `"version"`.
The health test was updated to assert the new body against `api.__version__` rather than a literal, and a second test asserts `app.version` equals the package constant.
No new dependency was added and the return type stays `dict[str, str]`.
Note for the reviewer: the README's service table still says `/health` returns `{"status":"ok"}`; that line was not touched by this change.

**Files that matter**

- `services/api/src/api/main.py` — imports `api.__version__`, passes it to `FastAPI(...)`, and adds `"version"` to the `/health` body so the string has one source inside the package.
- `services/api/tests/test_health.py` — asserts the new body against `api.__version__` and adds `test_app_version_matches_package` for the app object.
- `docs/health_version_plan.md` — the plan for this issue, committed for the record.

**Decisions made alone**

- The return type stays `dict[str, str]`; both values are strings, so no response model was added.
- No `importlib.metadata` and no new dependency: the package constant `api.__version__` is enough for this issue.
- The `FastAPI(...)` app object reads `version` from the same constant, so the OpenAPI docs and the health body cannot disagree.

**Review notes (not fixed)**

- (none)

**Follow-ups proposed**

- Read the API version from package metadata

## Verification recipe

- Branch: `jacques/che-5-health-endpoint-reports-the-api-version`
- PR: https://github.com/dvairus/ChessBuddy/pull/36
- Setup: `docker compose up --wait` from the repo root, or `uv sync` for the test-only path.
- Steps:
  1. Run `curl -s http://localhost:8000/health`.
  2. Open http://localhost:8000/docs in a browser.
  3. Run `uv run pytest services/api`.
  4. Run `uv run ruff check . && uv run ruff format --check . && uv run pyright`.
- Expected:
  - PASS when step 1 prints `{"status":"ok","version":"0.1.0"}`.
  - PASS when step 2 shows "ChessBuddy API" with `0.1.0` next to it in the page header.
  - PASS when step 3 reports all tests passed, including `test_health_returns_ok_and_version` and `test_app_version_matches_package`.
  - PASS when step 4 exits with no lint, format, or type errors.
