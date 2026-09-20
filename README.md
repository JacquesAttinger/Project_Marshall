# Project Marshall

<!-- Last edited: 2026-09-20 10:56 CDT -->

**TLDR:** Marshall watches a Linear board and runs Claude Code agents on the issues.
Iteration 1 is a Linear autopilot for one repo (ChessBuddy) on a laptop.
So far: runtime, config, SQLite, logging, CLI, quality gates, the Linear client, the agent runner (`src/runner/` launches `claude --bg` sessions, learns when they stop, and can kill or resume them), and the planning phase (`src/plan/` classifies an issue, launches the `/marshall:plan` agent, and checks its plan file).

## Setup

```bash
bun install
cp .env.example .env      # put the ChessBuddy key in MARSHALL_LINEAR_API_KEY
bun run migrate           # creates ~/.marshall/marshall.db
bin/marshall linear setup # creates the Needs Verification state and the marshall labels (once)
bin/marshall status       # prints config, state dir, schema version, row counts
```

The Linear key is `MARSHALL_LINEAR_API_KEY`, not `LINEAR_API_KEY`, so an exported Hemut key can never leak in.
See [`docs/linear_setup.md`](docs/linear_setup.md) for the manual steps and the conventions.

State lives in `~/.marshall/` (override with `MARSHALL_HOME`).
Config is `marshall.config.json` at the repo root (override with `--config <path>` or `MARSHALL_CONFIG`).

## Commands

| Command | What it does |
|---|---|
| `bin/marshall status [--json]` | Show config and DB state. Never writes. |
| `bin/marshall db migrate` | Create the state dir and apply pending migrations. |
| `bin/marshall linear setup [--json]` | Create the Linear state and labels Marshall needs. Idempotent. Refuses a key from another workspace. |
| `bin/marshall plan <identifier> --cwd <worktree> [--revise] [--json]` | Plan one issue in an existing worktree: classify, launch the planner, verify, post to Linear. |
| `bin/marshall plan check <file>` | Check a plan file for the required sections, in order. |
| `MARSHALL_LINEAR_E2E=1 bun test tests/linear.e2e.test.ts` | Run the real-workspace Linear test. Skipped otherwise. |
| `MARSHALL_LIVE=1 bun test tests/plan.live.test.ts` | Classify the five sample issues with the real Haiku. Skipped otherwise. |
| `bun test` | Run the test suite. |
| `bun run lint` / `bun run format` | Biome check / fix. |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run check:size` | 500 lines per file, 75 per function. |

The pre-commit hook runs lint-staged (Biome + size check), typecheck, and tests.

## Agent runner

Each agent launch passes a `--settings` JSON whose hooks append one JSON line per event to `~/.marshall/events/<runId>.jsonl`.
The runner watches that folder, writes the lines into the `events` table, and runs `claude stop` when the agent's turn ends.
`bun test` covers the runner with a fake `claude` shim.
`MARSHALL_LIVE=1 bun test tests/runner.live.test.ts` runs four real agents against the daemon (about 30 s, needs `claude` logged in).
See [`docs/runner.md`](docs/runner.md) for the exact command line and what each lifecycle state looks like.

## Plugin and skills

The repo root is a Claude Code plugin named `marshall` (`.claude-plugin/plugin.json`).
Agents launch with `--setting-sources project,local`, which never loads `~/.claude/skills/`, so every skill an agent needs lives under `skills/` here and is loaded per launch with `--plugin-dir <repo root>`.
`skills/plan/` is the autonomous planner (`/marshall:plan <brief>`); see [`docs/planning.md`](docs/planning.md).

## Docs

- [`docs/project_marshall_plan.md`](docs/project_marshall_plan.md) — the spec.
- [`docs/steps/`](docs/steps/) — iteration 1 build steps.
- [`docs/linear_setup.md`](docs/linear_setup.md) — what is configured in Linear and why.
- [`docs/runner.md`](docs/runner.md) — agent runner: command line, lifecycle states, live-test facts.
- [`docs/planning.md`](docs/planning.md) — planning phase: the brief, the skill, the classifier, the post-run checks.
