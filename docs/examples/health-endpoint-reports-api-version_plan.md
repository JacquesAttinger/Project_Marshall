# Health endpoint reports the API version

<!-- Last edited: 2026-09-20 12:47 CDT -->

**TLDR:** The `/health` endpoint only says "ok", so you cannot tell which API version a server runs.
We add the version string from the `api` package to the `/health` response and to the FastAPI app metadata.
Then anyone can hit `/health` after a deploy and see which version is live.

## Where to find it

This feature is not UI-reachable.
It is an HTTP endpoint: `GET /health` on the API service.
Locally, `docker compose up api` exposes it at `http://localhost:8000/health` (port mapping in `docker-compose.yml`).
The endpoint is also the container's liveness probe.

## Orientation

The area is `services/api/`, the FastAPI HTTP service for ChessBuddy.
The part is the `api` package under `services/api/src/api/`, which today holds only two files: `__init__.py` (package metadata, including `__version__ = "0.1.0"`) and `main.py` (the FastAPI app).
The exact section is `main.py`, which creates `app = FastAPI(title="ChessBuddy API", version="0.1.0")` and defines the `health()` route that returns `{"status": "ok"}`.

## What is wrong and why

`health()` in `services/api/src/api/main.py` returns only `{"status": "ok"}`, so an external check cannot confirm which build is running.
`main.py` also hardcodes `version="0.1.0"` in the `FastAPI(...)` call, duplicating the string that already lives in `api.__init__.py` as `__version__`.
The fix is to import `__version__` from the `api` package in `main.py`, pass it to `FastAPI(version=...)`, and add it to the health payload as `"version"`.
The test in `services/api/tests/test_health.py` then asserts the new two-key shape.

## Likely touched files

- `services/api/src/api/main.py` — import `__version__`, use it in `FastAPI(version=...)`, and add `"version"` to the health payload.
- `services/api/tests/test_health.py` — assert the response is `{"status": "ok", "version": api.__version__}`, and add a second test that `/openapi.json` reports the same version as `/health`.
- `docs/health-endpoint-reports-api-version_plan.md` — this plan.

## Plan

1. In `services/api/src/api/main.py`, add `from api import __version__`, change the app constructor to `FastAPI(title="ChessBuddy API", version=__version__)`, and change `health()` to return `{"status": "ok", "version": __version__}`.
   The `dict[str, str]` return annotation stays correct.
   In `services/api/tests/test_health.py`, import `api` and change the assertion to `response.json() == {"status": "ok", "version": api.__version__}`.
   In the same file, add `test_openapi_version_matches_health()`: fetch `client.get("/openapi.json")`, fetch `client.get("/health")`, and assert `openapi.json()["info"]["version"] == health.json()["version"]`.
   Update the "Last edited" comment at the top of both files.
   Run `uv run pytest services/api/tests` and confirm both test files pass.

## Decisions made alone

- **One step, one commit.** The change touches one route, one constructor, and one test, so splitting it would make commits smaller than a reviewable unit.
- **Test asserts against `api.__version__`, not the literal `"0.1.0"`.** The issue asks the test to assert the new shape, and the point of the shape is that the endpoint mirrors the package constant.
  The literal string stays pinned by the existing `test_package_imports` in `services/api/tests/test_api_import.py`, so drift is still caught there and that test does not change.
- **Import style is `from api import __version__`.** The package uses absolute `api.*` imports in tests, and importing the name directly keeps the two call sites in `main.py` short.
- **No change to the Docker healthcheck.** It only needs a 200 from `/health`, and the response stays a 200 with a JSON body, so adding a key cannot break it.
- **Scoped test run in verification.** The repo's full `uv run pytest` needs a Stockfish binary on `$PATH` (per `README.md`), which this change does not touch, so verification targets `services/api/tests`.
- **The OpenAPI test compares the two live responses, not each against the constant.** The bounce comment asks that `/openapi.json` "reports the same version as `/health`", so the test asserts `info.version` from `/openapi.json` equals `version` from `/health` directly.
  Equality with `api.__version__` is already pinned by the updated `test_health_returns_ok`, so a third assertion would be redundant.
- **The OpenAPI test lives in `test_health.py`.** It exercises the same app and the same version wiring, and the file already holds the `TestClient`; a new test module for one cross-check would be noise.

## Out of scope found

- **Version string duplicated in `services/api/pyproject.toml`** — `version = "0.1.0"` also lives there; the brief names deduplication (for example via `importlib.metadata`) as explicitly out of scope.

## Verification

Run `uv run pytest services/api/tests` from the repo root.
Expected: 3 tests pass with no failures (`test_health_returns_ok` and `test_openapi_version_matches_health` in `test_health.py`, and `test_package_imports` in `test_api_import.py`).
Manual check: `docker compose up api`, then `curl http://localhost:8000/health` returns `{"status":"ok","version":"0.1.0"}` and `curl http://localhost:8000/openapi.json` shows `"version": "0.1.0"` under `info`, then shut the container down.

## Revision 1

**Human comment (2026-09-20T17:20:11.197Z):**

> Bounce for the revise test: please keep the version constant read through `importlib.metadata` out of it as planned, but add a second test that the OpenAPI document (`/openapi.json`) reports the same version as `/health`. One step is still fine.

**What changed:**

The plan now adds a second test, `test_openapi_version_matches_health` in `services/api/tests/test_health.py`, which asserts that `info.version` in `/openapi.json` equals `version` in the `/health` response.
The plan stays one step and one commit, per the comment.
The `importlib.metadata` deduplication stays out of scope, unchanged from the original plan.
Verification now expects 3 passing tests and adds a `curl` check of `/openapi.json` to the manual check.

**Sections updated:** Likely touched files, Plan, Decisions made alone, Verification.
