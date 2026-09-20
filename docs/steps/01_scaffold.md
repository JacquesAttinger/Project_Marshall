# Step 01 — Scaffold

<!-- Last edited: 2026-09-19 21:05 CDT -->

**TLDR:** Set up the empty house before anyone moves in.
One runtime, one config file, one database, one logger, one CLI entry point, and a pre-commit hook that keeps the code clean.

## Goal

A runnable repo where every later step has a place to put code, a config to read, a database to write, and a test command that passes.

## Depends on / parallel with

- Depends on: nothing.
- Parallel with: nothing. Do this first. It is small.

## Spec references

Sections 4, 10.1, 11 of `project_jarvis_plan.md`.

## In scope

- Runtime: **Bun + TypeScript** (proposed). Bun is installed. It has SQLite and an HTTP server built in, which steps 03 and 09 need.
- Layout: `src/` for code, `skills/` for Claude skills, `docs/`, `scripts/`, `tests/`.
- Config: `jarvis.config.json` with a typed loader. Keys at minimum: `workspace`, `teamId`, `repoPath`, `baseBranch`, `maxAgents` (2), `dailyStartCap` (6), `windowStartCap` (2), `windowHours` (5), `pollSeconds`, `stallMinutes` (5), `issueTimeoutHours` (2), `maxFixCycles` (4), `maxBounces` (3), `maxResumes` (2), `ntfyTopicPrefix`.
- State dir: `~/.jarvis/` for `jarvis.db`, logs, and hand-off files. The repo stays clean.
- SQLite schema via `bun:sqlite`: `claims` (issue_id unique, agent_id, slot, state, branch, worktree_path, bounces, resumes, claimed_at, updated_at), `starts` (issue_id, started_at) for the caps, `events` (ts, issue_id, agent_id, type, payload). A `migrate` script.
- Logging: JSON lines to `~/.jarvis/logs/jarvis.log`, one logger module.
- CLI: `bin/jarvis` with `status` (prints config + DB counts) and `db migrate`.
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
- `src/config.ts`, `src/db.ts`, `src/log.ts`, `bin/jarvis`.
- `tests/config.test.ts`, `tests/db.test.ts`.
- `jarvis.config.json` pointing at ChessBuddy.

## Acceptance criteria

- `bun install && bun test` passes.
- `bin/jarvis status` prints the config and zero counts.
- `bin/jarvis db migrate` creates `~/.jarvis/jarvis.db` with the three tables.
- A commit with a lint error is rejected by the hook.

## Open questions for grilling

1. Bun + TypeScript, or Python to match ChessBuddy and job-watcher? The dashboard and hooks endpoint favor one runtime; ChessBuddy favors Python.
2. Biome (one tool) or ESLint + Prettier (the policy's named examples)?
3. State in `~/.jarvis/` or inside the repo under a git-ignored `.jarvis/`?
4. One config file, or config plus a `.env` for the Linear key?
5. Should `claims.slot` (0 or 1) exist now, so step 05 can derive the Compose project name and port offset from it?
