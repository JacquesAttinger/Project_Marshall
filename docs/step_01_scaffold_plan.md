# Step 01 — Scaffold: Implementation Plan

<!-- Last edited: 2026-09-19 21:40 CDT -->

## TLDR

Build the empty house for Marshall.
One runtime (Bun + TypeScript), one config file plus a `.env`, one SQLite database with numbered migrations, one small JSON logger, one CLI with two commands, and a pre-commit hook plus CI that keep the code clean.
No Linear, Claude, or ntfy calls yet.
When this lands, every later step has a place to put code and a test command that passes.

## Context

`docs/steps/01_scaffold.md` is wave 1 of the iteration 1 build.
Every later step imports from it.
The step file had five open questions.
They were answered in a grilling session on 2026-09-19, and the decisions are below.
The spec is `docs/project_marshall_plan.md`, sections 4, 10.1, and 11.

## Decisions (from grilling)

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

Routine choices made without asking: worktree at `.worktrees/step-01-scaffold` off `origin/main`, `status` prints a table with a `--json` flag, `events.payload` is JSON text.

## Facts verified

- Bun 1.4.2, Node 26.5.0, Python 3.14.6 are installed.
- `claude --bg` and `claude agents` exist. `~/.claude/jobs/<id>/state.json` is JSON.
- `~/.marshall/` does not exist yet.
- `origin/main` is at `a57c113` (PR #1 merged). The local `rename-to-marshall` branch is clean and merged.
- `~/.claude/skills/setup-pre-commit/SKILL.md` gives the Husky + lint-staged shape. We swap Prettier for Biome.
- `~/code/job-watcher/` keeps state in-repo and worktrees in `.worktrees/`. We take only the `.worktrees/` convention.

## Layout

```
Project_Marshall/
├── bin/marshall                  # #!/usr/bin/env bun → src/cli/index.ts
├── src/
│   ├── config.ts                 # Zod schema, loadConfig(), loadEnv(), resolve paths
│   ├── paths.ts                  # marshallHome(), dbPath(), logPath(), handoffDir()
│   ├── log.ts                    # createLogger(), child loggers, JSONL append
│   ├── db/
│   │   ├── index.ts              # openDb(path), migrate(db), counts(db)
│   │   └── migrations/
│   │       └── 001_init.sql      # claims, starts, events
│   └── cli/
│       ├── index.ts              # command map + dispatch
│       ├── status.ts             # `marshall status [--json]`
│       └── db.ts                 # `marshall db migrate`
├── scripts/check-size.ts         # 500 lines/file, 75 lines/function
├── tests/
│   ├── config.test.ts
│   ├── db.test.ts
│   ├── log.test.ts
│   └── check-size.test.ts
├── skills/                       # empty, .gitkeep; steps 04–06 fill it
├── docs/                         # existing
├── marshall.config.json
├── .env.example
├── package.json, tsconfig.json, biome.json, .lintstagedrc
├── .husky/pre-commit
├── .github/workflows/ci.yml
├── .gitignore, README.md
```

Every new source file starts with a `// Last edited: YYYY-MM-DD HH:MM CDT` comment (global policy).

## Files and behavior

### `package.json`

- `"type": "module"`, `"private": true`.
- Scripts: `test` (`bun test`), `typecheck` (`tsc --noEmit`), `lint` (`biome check .`), `format` (`biome check --write .`), `check:size` (`bun scripts/check-size.ts`), `prepare` (`husky`), `migrate` (`bun bin/marshall db migrate`).
- Dependencies: `zod`.
- Dev dependencies: `typescript`, `@types/bun`, `@biomejs/biome`, `husky`, `lint-staged`.
- `"bin": { "marshall": "bin/marshall" }` so `bun link` works.

### `tsconfig.json`

Strict. `moduleResolution: bundler`, `types: ["bun-types"]`, `noEmit`, `include: ["src", "tests", "scripts", "bin"]`.

### `biome.json`

Recommended rules on. Formatter: 2 spaces, double quotes, 100 columns.
Organize imports on.
Ignore `.worktrees`, `node_modules`, `docs`.

### `.lintstagedrc`

```json
{
  "*.{ts,json,md}": "biome check --write --no-errors-on-unmatched --files-ignore-unknown=true",
  "*.ts": "bun scripts/check-size.ts"
}
```

### `.husky/pre-commit`

```
bunx lint-staged
bun run typecheck
bun test
```

### `.github/workflows/ci.yml`

On `pull_request` and `push` to `main`.
`oven-sh/setup-bun@v2` → `bun install --frozen-lockfile` → `bun run lint` → `bun run typecheck` → `bun run check:size` → `bun test`.

### `.gitignore`

`node_modules/`, `.env`, `.worktrees/`, `.DS_Store`, `*.log`, `bun.lock` stays committed.

### `marshall.config.json`

```json
{
  "workspace": "chessbuddy",
  "teamId": "",
  "repoPath": "~/code/ChessBuddy",
  "baseBranch": "main",
  "maxAgents": 2,
  "dailyStartCap": 6,
  "windowStartCap": 2,
  "windowHours": 5,
  "pollSeconds": 45,
  "stallMinutes": 5,
  "issueTimeoutHours": 2,
  "maxFixCycles": 4,
  "maxBounces": 3,
  "maxResumes": 2
}
```

`teamId` stays empty until step 02 looks it up. The schema allows empty for now and step 02 tightens it.

### `.env.example`

```
LINEAR_API_KEY=
NTFY_TOPIC_PREFIX=
```

Both optional in step 01. Steps 02 and 09 make them required.

### `src/paths.ts`

- `marshallHome()` → `process.env.MARSHALL_HOME ?? ~/.marshall`.
- `dbPath()`, `logDir()`, `logPath()`, `handoffDir()` derive from it.
- `ensureHome()` creates the dir tree with `mkdir -p` semantics.
- `expandTilde(p)` helper, used by `config.ts` for `repoPath`.

### `src/config.ts`

- `ConfigSchema` (Zod): every key above with defaults and bounds.
  `maxAgents` 1–3, caps ≥ 1, `windowHours` 1–24, `pollSeconds` 10–600.
  `repoPath` is tilde-expanded and must be an existing directory.
- `EnvSchema` (Zod): `LINEAR_API_KEY`, `NTFY_TOPIC_PREFIX`, both `string().optional()` for now.
- `loadConfig(path?)`: resolves `--config` > `MARSHALL_CONFIG` > `<repo root>/marshall.config.json`.
  Repo root is `import.meta.dir/..`.
  Returns a frozen typed object. Throws a `ConfigError` with the key path on failure.
- `loadEnv()`: parses `process.env` through `EnvSchema`. Bun loads `.env` on its own.
- Export `type Config`.

### `src/log.ts`

- `createLogger(base?: Record<string, unknown>)` returns `{ debug, info, warn, error, child }`.
- Each call appends `{ ts, level, event, ...base, ...fields }` as one JSON line to `logPath()`, sync append.
- Mirrors to stderr when `process.stderr.isTTY` and `MARSHALL_QUIET` is not set.
- `child(fields)` merges base fields, for `issueId` and `agentId` later.
- About 40 lines. No rotation.

### `src/db/index.ts`

- `openDb(path = dbPath())`: `new Database(path, { create: true })`, `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`.
- `migrate(db)`: reads `migrations/*.sql` sorted, applies each whose number is greater than `PRAGMA user_version`, one transaction per file, sets `user_version`.
  Returns the list applied.
- `schemaVersion(db)`.
- `counts(db)` → `{ claims, starts, events }` for `status`.

### `src/db/migrations/001_init.sql`

```sql
CREATE TABLE claims (
  issue_id      TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  slot          INTEGER NOT NULL CHECK (slot IN (0, 1, 2)),
  state         TEXT NOT NULL,
  branch        TEXT,
  worktree_path TEXT,
  bounces       INTEGER NOT NULL DEFAULT 0,
  resumes       INTEGER NOT NULL DEFAULT 0,
  claimed_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX claims_live_slot
  ON claims (slot)
  WHERE state NOT IN ('released', 'blocked');

CREATE TABLE starts (
  id         INTEGER PRIMARY KEY,
  issue_id   TEXT NOT NULL,
  started_at TEXT NOT NULL
);
CREATE INDEX starts_started_at ON starts (started_at);

CREATE TABLE events (
  id       INTEGER PRIMARY KEY,
  ts       TEXT NOT NULL,
  issue_id TEXT,
  agent_id TEXT,
  type     TEXT NOT NULL,
  payload  TEXT
);
CREATE INDEX events_issue ON events (issue_id, ts);
```

Slot allows 0–2 so the cap can go to 3 later without a migration.
Timestamps are ISO-8601 text.

### `src/cli/index.ts`, `status.ts`, `db.ts`

- `index.ts`: parses `argv`, maps `status` → `runStatus`, `db migrate` → `runMigrate`.
  Unknown command prints usage and exits 2.
  Errors print one line and exit 1.
- `status.ts`: loads config, opens DB (no migrate), prints a table of config keys, `MARSHALL_HOME`, schema version, and counts.
  `--json` prints one JSON object.
- `db.ts`: `ensureHome()`, `openDb()`, `migrate()`, prints the migrations applied.

### `bin/marshall`

```
#!/usr/bin/env bun
import "../src/cli/index.ts";
```

Executable bit set.

### `scripts/check-size.ts`

- Args: file paths (from lint-staged) or, with none, every `.ts` under `src`, `scripts`, `tests`, `bin`.
- File check: count lines, fail if > 500.
- Function check: `ts.createSourceFile`, walk `FunctionDeclaration`, `MethodDeclaration`, `ArrowFunction`, `FunctionExpression`; fail if `end line - start line + 1 > 75`.
- Output: `path:line name 91 > 75`. Exit 1 on any failure.
- Under 75 lines itself.

### `README.md`

Short: what Marshall is, `bun install`, `cp .env.example .env`, `bun run migrate`, `bin/marshall status`, link to `docs/`.

### `docs/steps/01_scaffold.md`

Replace the "Open questions for grilling" section with a "Decisions" table (the 15 rows above).
Update the "Last edited" stamp.

## Tests

- `tests/config.test.ts`: valid object passes with defaults; `maxAgents: 5` fails naming the key; `repoPath` missing dir fails; tilde expands; `MARSHALL_CONFIG` override is honored.
- `tests/db.test.ts`: `:memory:` DB; `migrate` creates three tables and sets `user_version = 1`; second `migrate` applies nothing; two live claims on the same slot throw; a released claim frees the slot; `counts` returns zeros.
- `tests/log.test.ts`: `MARSHALL_HOME` temp dir; one call writes one parseable JSON line with `ts`, `level`, `event`; child fields merge.
- `tests/check-size.test.ts`: a fixture string with an 80-line function fails; a 70-line one passes.

All tests set `MARSHALL_HOME` to a temp dir in `beforeEach` and remove it in `afterEach`.

## Order of work

1. Worktree: `git worktree add .worktrees/step-01-scaffold -b step-01-scaffold origin/main`. Add `.worktrees/` to `.gitignore` first commit.
2. `bun init`-style `package.json`, `tsconfig.json`, `biome.json`. `bun add zod`, `bun add -d typescript @types/bun @biomejs/biome husky lint-staged`.
3. `src/paths.ts`, `src/config.ts`, `tests/config.test.ts`.
4. `src/db/`, `tests/db.test.ts`.
5. `src/log.ts`, `tests/log.test.ts`.
6. `src/cli/`, `bin/marshall`.
7. `scripts/check-size.ts`, `tests/check-size.test.ts`.
8. `bunx husky init`, `.husky/pre-commit`, `.lintstagedrc`, `ci.yml`.
9. `marshall.config.json`, `.env.example`, `README.md`, `.gitignore`.
10. Update `docs/steps/01_scaffold.md` with the decisions table.
11. Run the acceptance checks below. Commit. Open the PR. No Linear issue.

## Verification (acceptance criteria)

1. `bun install && bun test` passes.
2. `bin/marshall status` prints the config, `MARSHALL_HOME`, schema version 0, and zero counts.
3. `bin/marshall db migrate` creates `~/.marshall/marshall.db`; `sqlite3 ~/.marshall/marshall.db .tables` lists `claims starts events`; `PRAGMA user_version` is 1.
4. `bin/marshall status` after migrate shows schema version 1.
5. A commit with an unused variable is rejected by the hook. Fix it, commit passes.
6. A commit with an 80-line function is rejected with `path:line name 80 > 75`.
7. `bun run lint`, `bun run typecheck`, `bun run check:size` are all clean.
8. CI is green on the PR.
9. Clean up: no dev server or process is left running. Remove the test `~/.marshall/marshall.db` only if you want a fresh state before step 07.

## Out of scope

- Linear, Claude, ntfy calls (steps 02, 03, 09).
- Log rotation, `run`, `kill` commands (step 09).
- The dashboard (iteration 2).
