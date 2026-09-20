# Project Marshall

<!-- Last edited: 2026-09-19 21:28 CDT -->

**TLDR:** Marshall watches a Linear board and runs Claude Code agents on the issues.
Iteration 1 is a Linear autopilot for one repo (ChessBuddy) on a laptop.
This is the scaffold: runtime, config, SQLite, logging, CLI, and quality gates.

## Setup

```bash
bun install
cp .env.example .env      # fill in later steps; both keys are optional for now
bun run migrate           # creates ~/.marshall/marshall.db
bin/marshall status       # prints config, state dir, schema version, row counts
```

State lives in `~/.marshall/` (override with `MARSHALL_HOME`).
Config is `marshall.config.json` at the repo root (override with `--config <path>` or `MARSHALL_CONFIG`).

## Commands

| Command | What it does |
|---|---|
| `bin/marshall status [--json]` | Show config and DB state. Never writes. |
| `bin/marshall db migrate` | Create the state dir and apply pending migrations. |
| `bun test` | Run the test suite. |
| `bun run lint` / `bun run format` | Biome check / fix. |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run check:size` | 500 lines per file, 75 per function. |

The pre-commit hook runs lint-staged (Biome + size check), typecheck, and tests.

## Docs

- [`docs/project_marshall_plan.md`](docs/project_marshall_plan.md) — the spec.
- [`docs/steps/`](docs/steps/) — iteration 1 build steps.
