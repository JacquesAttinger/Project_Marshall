# Step 03 — Agent Runner — Implementation Plan

<!-- Last edited: 2026-09-19 21:55 CDT -->

**TLDR:** Build the module that starts a Claude agent in the background, learns when it stops, and can kill or resume it.
Hooks inside the agent append JSON lines to a file under `~/.marshall/events/`.
The runner watches that folder, writes the events into SQLite, and stops the session when its turn ends.
It reads three sources for status: the daemon's `claude agents --json` for "is it alive", the transcript file's mtime for "is it still working", and `state.json` for ids and timestamps.
Fast tests with fake files run in CI. One live test against the real `claude --bg` runs by hand before the PR.

Step file: `docs/steps/03_agent_runner.md`. Spec: `docs/project_marshall_plan.md` sections 4, 6.6, 10.1, 12.

## Context

Step 08 (master agent) needs a small, honest API over `claude --bg`: launch, know when it finished or failed, detect stalls, resume, kill, and recognize a rate-limit failure so the queue can pause.
The step file left six open questions.
Four were answered by reading the CLI, the daemon's job files, and the hooks docs.
The other two, plus three more that the facts surfaced, were decided in a grilling session on 2026-09-19.

## Decisions (from grilling)

| # | Question | Decision |
|---|---|---|
| 1 | Hook transport | **File-append command hook.** Each hook runs `scripts/hook-sink.sh <MARSHALL_HOME>/events/<runId>.jsonl`, which wraps stdin in `{received_at, event}` and appends one line. The runner watches the folder. No HTTP server, no port. Supersedes spec decision #17's "HTTP hooks" wording; the spec's intent (agent → orchestrator signaling without polling) is kept. |
| 2 | Settings isolation | **Isolate.** Every launch passes `--setting-sources project,local` so `~/.claude/settings.json` (9 personal hooks, Concise output style, plugins) does not leak into agents. A committed `agent-settings.json` carries what agents need; the runner merges the per-run hooks into it and passes the result as inline `--settings` JSON. |
| 3 | After the turn ends | **Runner auto-stops.** A `--bg` session stays resident and idle after its turn. On `finished` (a `Stop` whose `background_tasks` is empty) or on `StopFailure`, the runner runs `claude stop <jobId>`, then emits the event. Resume always targets a stopped session, so `--bg --resume` never creates a copy. |
| 4 | Status source of truth | **Three sources.** Liveness: `claude agents --json --all` filtered by id. Progress: transcript mtime and newest hook event. Ids and timestamps: `state.json`. `isStalled` = alive and no progress for N minutes. |
| 5 | Test strategy | **Two tiers.** Fixture-driven unit tests run in CI with a fake `claude` shim on `PATH`. A live smoke test gated by `MARSHALL_LIVE=1` runs the four acceptance criteria against the real daemon and produces the values recorded in `docs/runner.md`. |

Recommendations taken without a question:

- **Model alias:** the caller passes `model` (`opus`, `fable`, `haiku`) and optional `effort`; the runner passes them through to `--model` / `--effort`. `fable` resolves through `env.ANTHROPIC_DEFAULT_FABLE_MODEL` in `agent-settings.json`.
- **Resume shape:** `resume({ sessionId, cwd, prompt })`. Step 08 supplies the nudge prompt.
- **Job identity:** the runner mints a `runId` (`<name>-<8 hex>`) before spawning, because the hook command must be built before the daemon's job id exists. A `runs` table maps `runId → jobId → sessionId`.
- **Escape hatch:** `launch` accepts `extraArgs?: string[]` so steps 04/05/08 can add flags such as `--plugin-dir` without touching the runner.

## Facts verified

- `claude --bg --name <n> --model <m> --effort <e> --permission-mode bypassPermissions --setting-sources project,local --settings '<json>' --append-system-prompt <t> [prompt]` is a valid command line. `--dangerously-skip-permissions` is documented as an alias for `--permission-mode bypassPermissions`.
- `claude --bg --resume <sessionId>` "continues that session in the background under the same ID, or starts a copy and says so when the session is already running".
- `claude agents --json --all` prints background and interactive sessions as a JSON array without a TTY. Fields: `id`, `cwd`, `kind`, `startedAt`, `sessionId`, `name`, `state` (`done`, `failed`, ...). It reported job `c140930f` as `failed` while its `state.json` said `working`.
- `~/.claude/jobs/<id>/state.json` keys seen: `state`, `tempo`, `detail`, `output` (`{result}` or null), `tokens`, `name`, `sessionId`, `resumeSessionId`, `daemonShort`, `cwd`, `createdAt`, `updatedAt`, `firstTerminalAt`, `lastTerminalAt`, `linkScanPath` (transcript path, sometimes), `respawnFlags`, `backend`.
- `updatedAt` moves only on state transitions (`cbee1ba4`: `updatedAt == firstTerminalAt`; `c140930f`: `updatedAt == createdAt` for weeks while `working`).
- Hooks fire in `--bg` sessions: cmux passes a `--settings` hooks JSON to every bg job (visible in `respawnFlags`).
- Hook events and payloads (docs, `code.claude.com/docs/en/hooks`):
  - Common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`.
  - `Stop`: adds `last_assistant_message`, `stop_hook_active`, `background_tasks[]`, `session_crons[]`. Does not fire on API errors.
  - `StopFailure`: fires instead of `Stop` on API errors. `error` is one of `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown`. Also `error_details`, `last_assistant_message`.
  - `SessionEnd`: adds `reason`. Default hook timeout 1.5 s.
  - `Notification`: `notification_type` includes `quota_auto_resume_fired|stale|disabled`.
  - `SessionStart` gives `session_id` before `state.json` has it.
  - Hook entries merge across settings levels. `--setting-sources user,project,local` chooses which files load; `--settings` still applies.
- Transcript path: `~/.claude/projects/<slug>/<sessionId>.jsonl` where `slug` = cwd with every non-alphanumeric character replaced by `-` (`~/code/Project_Marshall` → `-Users-jacquesattinger-code-Project-Marshall`). Prefer `state.json.linkScanPath` when present.
- Personal `~/.claude/settings.json` holds: `env` (incl. `ANTHROPIC_DEFAULT_FABLE_MODEL`), `model: opus`, `effortLevel: high`, `modelSettings`, `outputStyle: Concise`, `skipDangerousModePermissionPrompt: true`, `enabledPlugins`, 3 Stop hooks, 1 PostToolUse hook, 6 SessionStart hooks.
- `origin/main` is at `f6366ec` (PR #2, step 01, merged). Step 02 is not started. Step 03 is parallel with 02 and shares no files with it.

## Layout

New files:

```
agent-settings.json                 committed base settings for every agent
scripts/hook-sink.sh                POSIX sh: wrap stdin, append one line to $1
src/runner/index.ts                 public API re-exports
src/runner/types.ts                 LaunchOpts, Run, RunStatus, HookEvent, Terminal
src/runner/settings.ts              buildAgentSettings(runId) → JSON string
src/runner/launch.ts                launch, resume, kill (Bun.spawn around claude)
src/runner/status.ts                state.json, agents --json, transcript mtime, isStalled
src/runner/events.ts                watcher, ingest, classify, rateLimited, auto-stop
src/db/migrations/002_runs.sql      runs table
tests/runner/settings.test.ts
tests/runner/status.test.ts
tests/runner/events.test.ts
tests/runner/launch.test.ts         uses tests/fixtures/fake-claude (shim on PATH)
tests/runner.live.test.ts           gated by MARSHALL_LIVE=1
tests/fixtures/jobs/*/state.json    three real shapes, ids redacted
tests/fixtures/hooks/*.json         Stop (empty and busy), StopFailure rate_limit, SessionEnd, SessionStart
tests/fixtures/fake-claude          executable script that mimics `claude --bg`, `agents --json`, `stop`
docs/runner.md                      exact command lines + state.json values per lifecycle state
docs/step_03_agent_runner_plan.md   this plan
```

Changed files:

- `src/paths.ts`: add `eventsDir()`, `claudeHome()` (`CLAUDE_CONFIG_DIR` or `~/.claude`), `claudeJobsDir()`, `transcriptPath(cwd, sessionId)`; `ensureHome()` also creates `eventsDir()`.
- `src/db/index.ts`: `counts()` gains `runs`.
- `src/cli/status.ts`: add a `runs` count line. No new subcommand (step 09 owns the CLI).
- `docs/steps/03_agent_runner.md`: replace "Open questions for grilling" with the Decisions table above; bump the stamp.
- `README.md`: one paragraph on the events folder and `MARSHALL_LIVE`.

Every file under 500 lines, every function under 75 lines (`scripts/check-size.ts` enforces this at commit).
Every edited file gets the `Last edited` stamp on line 1.

## Module design

### `agent-settings.json` (committed)

```json
{
  "skipDangerousModePermissionPrompt": true,
  "preferredNotifChannel": "notifications_disabled",
  "includeCoAuthoredBy": false,
  "env": { "ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-fable-5[1m]" },
  "effortLevel": "high"
}
```

`src/runner/settings.ts` → `buildAgentSettings(runId, marshallHome)`: reads this file, adds `hooks` for `SessionStart`, `Stop`, `StopFailure`, `SubagentStop`, `Notification`, `SessionEnd`, each pointing at `scripts/hook-sink.sh <eventsDir>/<runId>.jsonl` with `timeout: 5` (`SessionEnd`: `timeout: 3`), returns the JSON string.
Hooks are synchronous (no `async: true`) so ordering is preserved; the sink takes milliseconds.

### `scripts/hook-sink.sh`

```sh
#!/bin/sh
# Last edited: <stamp>
# Append one JSON line {received_at, event} to $1. Stdin is the hook payload.
set -eu
out="$1"; mkdir -p "$(dirname "$out")"
{ printf '{"received_at":"%s","event":' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; cat; printf '}\n'; } >> "$out"
```

Appends under `PIPE_BUF` are atomic for the one-writer-per-file case.

### `src/runner/types.ts`

```ts
export interface LaunchOpts {
  name: string; cwd: string; prompt: string;
  model: string; effort?: "low"|"medium"|"high"|"xhigh"|"max";
  systemPromptAppend?: string; maxBudgetUsd?: number; extraArgs?: string[];
}
export interface Run { runId; jobId; sessionId: string|null; name; cwd; state: RunState; createdAt; finishedAt: string|null; error: string|null }
export type RunState = "starting"|"running"|"finished"|"failed"|"killed";
export interface RunStatus { run: Run; alive: boolean; daemonState: string|null; lastActivityAt: string|null; tokens: number|null }
export interface HookEvent { receivedAt: string; runId: string; name: string; payload: Record<string, unknown> }
```

### `src/runner/launch.ts`

- `launch(db, opts)`: mint `runId`; insert `runs` row (`state: starting`); build argv:
  `claude --bg --name <name> --model <m> [--effort <e>] --permission-mode bypassPermissions --setting-sources project,local --settings <json> [--append-system-prompt <t>] [--max-budget-usd <n>] [...extraArgs] <prompt>`;
  `Bun.spawn` with `cwd`, capture stdout, parse the first `[0-9a-f]{8}` as `jobId`; update the row; log `run.launched`.
  The `claude` binary path comes from `MARSHALL_CLAUDE_BIN` (default `claude`) so tests can point at the shim.
- `resume(db, { sessionId, cwd, prompt, name })`: same argv with `--resume <sessionId>` and a fresh `runId`; the new row carries `resumed_from`.
- `kill(db, jobId)`: `claude stop <jobId>`; mark `killed`; log.
- One helper `runClaude(args, cwd)` wraps spawn, timeout (30 s), and non-zero exit → `RunnerError`.

### `src/runner/status.ts`

- `readJobState(jobId)`: parse `state.json`; missing file → `null`.
- `listDaemonSessions()`: `claude agents --json --all`, keep `kind === "background"`.
- `transcriptMtime(cwd, sessionId, linkScanPath?)`.
- `status(db, runId)`: joins the three; `lastActivityAt = max(transcript mtime, newest hook event received_at)`.
- `isStalled(db, runId, minutes, now = Date.now())`: `alive && lastActivityAt < now - minutes`.

### `src/runner/events.ts`

- `ingestFile(db, runId)`: read from `runs.events_offset`, parse whole lines, insert into `events` (`type = "hook.<name>"`, `agent_id = jobId`, `payload` = JSON), advance the offset in the same transaction. A partial trailing line is left for the next pass.
- `classify(event)`: `Stop` with empty `background_tasks` → `finished`; `StopFailure` → `failed` with `error`; `SessionStart` → record `session_id`; others → informational.
- `rateLimited(event)`: `name === "StopFailure" && payload.error === "rate_limit"`. Also export `failureKind(event)` for step 08.
- `startWatcher(db, onTerminal)`: catch-up scan of every file in `eventsDir()` for runs not terminal, then `fs.watch(eventsDir)`; on each change ingest that file; on `finished`/`failed` call `kill`-style stop (`claude stop`), update `runs`, then invoke `onTerminal(run, event)`. Returns `{ stop() }`.

### `002_runs.sql`

```sql
CREATE TABLE runs (
  run_id        TEXT PRIMARY KEY,
  job_id        TEXT,
  session_id    TEXT,
  name          TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  state         TEXT NOT NULL,
  error         TEXT,
  resumed_from  TEXT,
  events_offset INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX runs_job ON runs (job_id);
CREATE INDEX runs_session ON runs (session_id);
```

## Tests

All tests set `MARSHALL_HOME` to a temp dir and use `:memory:` (pattern from `tests/helpers.ts`).
`MARSHALL_CLAUDE_BIN` points at `tests/fixtures/fake-claude` and `CLAUDE_CONFIG_DIR` at a temp dir holding fixture jobs.

- `settings.test.ts`: output parses; contains six hook events; every hook command names the run's events file; base keys survive; no `hooks` key from the base file is dropped.
- `status.test.ts`: the three fixture `state.json` shapes parse; stale `working` + daemon `failed` → `alive: false`; `isStalled` true when transcript mtime and last event are older than the threshold, false when either is fresh, false when not alive.
- `events.test.ts`: a file with three lines ingests three `events` rows and advances the offset; a partial trailing line waits; `Stop` with `background_tasks: [ … ]` is not `finished`; `StopFailure rate_limit` → `rateLimited` true; `overloaded` → false; catch-up on watcher start ingests a pre-existing file; terminal event triggers the fake `claude stop` (the shim records calls to a file).
- `launch.test.ts`: argv is exactly as documented (assert on the shim's recorded argv); `jobId` parsed from shim stdout; non-zero exit → `RunnerError`; `resume` passes `--resume` and `resumed_from`.
- `runner.live.test.ts` (skipped unless `MARSHALL_LIVE=1`): the four acceptance criteria against the real daemon in a temp git repo.
  1. launch "Print hello, then stop." → `finished` within 120 s → daemon shows the job stopped.
  2. launch "Count to 1000 slowly with Bash sleep 1 between numbers." → `kill` after 10 s → `alive: false`, `pgrep -f <sessionId>` empty.
  3. resume the first session with "What did you print earlier?" → `last_assistant_message` contains "hello".
  4. `isStalled` on a job whose transcript mtime is set 10 minutes back with `utimes` → true.
  Writes the observed `state.json` per state and the exact argv into `docs/runner.md` sections.

## Order of work

1. Worktree: `git worktree add .worktrees/step-03-agent-runner -b feat/step-03-agent-runner origin/main` (after `git fetch`; `.worktrees/` is already ignored). Copy `.env` if present.
2. `docs/step_03_agent_runner_plan.md` (this plan), update `docs/steps/03_agent_runner.md` decisions.
3. `src/paths.ts` additions + `002_runs.sql` + `counts()`; tests.
4. `agent-settings.json`, `scripts/hook-sink.sh`, `src/runner/settings.ts`; test.
5. `src/runner/types.ts`, `status.ts`; fixtures; test.
6. `src/runner/events.ts`; test.
7. `src/runner/launch.ts`, `index.ts`; fake shim; test.
8. `tests/runner.live.test.ts`; run it with `MARSHALL_LIVE=1`; write `docs/runner.md` from its output.
9. `bun run lint && bun run typecheck && bun test` once at the end. Commit through the pre-commit hook (no `--no-verify`).
10. PR to `main`, titled "Step 03: agent runner". Concise description. Do not merge. No Linear issue (same as step 01).

## Verification

- CI: `bun test` green on the PR without `claude` on `PATH`.
- Local: `MARSHALL_LIVE=1 bun test tests/runner.live.test.ts` passes all four criteria; `claude agents --json --all` shows the test jobs stopped; `~/.marshall/events/` holds one file per run with `SessionStart`, `Stop` (or `StopFailure`), and `SessionEnd` lines.
- `marshall status` prints a `runs` count.
- `bun run check:size` reports no file over 500 lines and no function over 75.
- After the live test, `claude rm` the test jobs so the daemon roster is clean.

## Out of scope (unchanged from the step file)

- Prompt content (steps 04, 05, 08). Worktree creation (step 07). Pausing the queue (step 08). CLI subcommands for runs (step 09).
