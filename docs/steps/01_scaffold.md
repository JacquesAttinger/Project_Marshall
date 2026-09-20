# Step 01 — Scaffold

<!-- Last edited: 2026-09-19 21:28 CDT -->

**TLDR:** Set up the empty house before anyone moves in.
One runtime, one config file, one database, one logger, one CLI entry point, and a pre-commit hook that keeps the code clean.

## Goal

A runnable repo where every later step has a place to put code, a config to read, a database to write, and a test command that passes.

## Depends on / parallel with

- Depends on: nothing.
- Parallel with: nothing. Do this first. It is small.

## Spec references

Sections 4, 10.1, 11 of `project_marshall_plan.md`.

## In scope

- Runtime: **Bun + TypeScript**. Bun is installed. It has SQLite and an HTTP server built in, which steps 03 and 09 need.
- Layout: `src/` for code, `skills/` for Claude skills, `docs/`, `scripts/`, `tests/`.
- Config: `marshall.config.json` with a typed loader. Keys at minimum: `workspace`, `teamId`, `repoPath`, `baseBranch`, `maxAgents` (2), `dailyStartCap` (6), `windowStartCap` (2), `windowHours` (5), `pollSeconds`, `stallMinutes` (5), `issueTimeoutHours` (2), `maxFixCycles` (4), `maxBounces` (3), `maxResumes` (2). `NTFY_TOPIC_PREFIX` and `LINEAR_API_KEY` live in `.env` (decision 4).
- State dir: `~/.marshall/` for `marshall.db`, logs, and hand-off files. The repo stays clean.
- SQLite schema via `bun:sqlite`: `claims` (issue_id unique, agent_id, slot, state, branch, worktree_path, bounces, resumes, claimed_at, updated_at), `starts` (issue_id, started_at) for the caps, `events` (ts, issue_id, agent_id, type, payload). A `migrate` script.
- Logging: JSON lines to `~/.marshall/logs/marshall.log`, one logger module.
- CLI: `bin/marshall` with `status` (prints config + DB counts) and `db migrate`.
- Pre-commit: Biome (lint + format) + typecheck + `bun test` via Husky and lint-staged. Config committed.
- File and function size limits from the global policy: 500 lines per file, 75 per function. Add a Biome or script check.
- `.gitignore`, `README.md` (short), and copy `.env` handling into `.gitignore`.

## Out of scope

- Any Linear, Claude, or ntfy calls. Those are steps 02, 03, 09.
- The web dashboard.

## Reuse (search first)

- `~/.claude/skills/setup-pre-commit/` — Husky + lint-staged recipe.
- `~/code/job-watcher/` — a small local daemon with `state/` and `runs/` dirs; compare its layout before inventing one.
- Global policy on file size and pre-commit hooks in `~/.claude/CLAUDE.md`.

## Deliverables

- `package.json`, `tsconfig.json`, `biome.json`, `.husky/pre-commit`, `.lintstagedrc`.
- `src/config.ts`, `src/paths.ts`, `src/db/`, `src/log.ts`, `src/cli/`, `bin/marshall`.
- `tests/config.test.ts`, `tests/db.test.ts`, `tests/log.test.ts`, `tests/cli.test.ts`, `tests/check-size.test.ts`.
- `marshall.config.json` pointing at ChessBuddy.

## Acceptance criteria

- `bun install && bun test` passes.
- `bin/marshall status` prints the config and zero counts.
- `bin/marshall db migrate` creates `~/.marshall/marshall.db` with the three tables.
- A commit with a lint error is rejected by the hook.

## Decisions

Answered in a grilling session on 2026-09-19.
The full implementation plan is in `docs/step_01_scaffold_plan.md`.

| # | Decision | Choice |
|---|---|---|
| 1 | Runtime | Bun 1.4 + TypeScript. `bun:sqlite`, `bun test`, `Bun.serve` later. |
| 2 | Lint + format | Biome. One tool, one config. |
| 3 | State dir | `~/.marshall/`, overridable with `MARSHALL_HOME`. |
| 4 | Config vs secrets | `marshall.config.json` (committed, repo root) + `.env` (gitignored) + `.env.example` (committed). |
| 5 | Config path | Repo root. `--config <path>` or `MARSHALL_CONFIG` overrides. |
| 6 | Validation | Zod schema for config and env. |
| 7 | `claims.slot` | Yes, now. Partial unique index on live claims. |
| 8 | Migrations | Numbered SQL files + `PRAGMA user_version`. |
| 9 | Size limits | `scripts/check-size.ts` with exact file and function counts via the TS compiler API. |
| 10 | Pre-commit | lint-staged (Biome + size check on staged) → `tsc --noEmit` → `bun test`. |
| 11 | CLI | `bin/marshall` shebang + hand-rolled dispatch. No dependency. |
| 12 | Logger | Tiny JSONL logger, zero deps. |
| 13 | Test isolation | `MARSHALL_HOME` temp dir + `:memory:` DB. |
| 14 | CI | GitHub Actions `ci.yml` now. |
| 15 | Linear | No tracking issue for this PR. |

One deviation found during the build: `typescript` is pinned to 5.x.
TypeScript 7 (the native port) ships no stable compiler API, and `check-size.ts` needs `createSourceFile`.
