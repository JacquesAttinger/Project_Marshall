# Step 09 — Ops: launchd, notifications, CLI: implementation plan

<!-- Last edited: 2026-09-20 23:35 CDT -->

## TLDR

Marshall gets three things: it starts by itself when the laptop boots and stays awake, it sends a push to Jacques's phone when something needs him, and the terminal gets control commands (`status`, `start`, `stop`, `pause`, `resume`, `kill`, `logs`).
A small watcher reads Marshall's own event log in the database and turns six event types into phone pushes.
A runbook page explains how to install, stop, and repair it.

## Context

Step 09 of `docs/steps/09_ops_launchd_notifications_cli.md`, spec sections 7, 8.1, 9, 10.1.
Steps 01–08 are merged; the master agent already records every event in the SQLite `events` table as `master.<name>` (`src/master/types.ts` lists them), and `flags` already holds `pause_until` for the rate-limit pause.
`bin/marshall` dispatches through `src/cli/index.ts` (hand-rolled, no CLI library).
The local checkout is behind: **cut a fresh worktree from `origin/main`** (branch `feat/step-09-ops`), run `bun install` there (husky hooks), and copy `.env` in.

## Decisions from the grilling (2026-09-20)

1. **Notify wiring:** tail the `events` table with a persisted cursor; no direct calls from `emit()`.
2. **Push content:** issue identifier + title + Linear link only. Hand-off text never leaves the laptop. Public ntfy.sh with the hard-to-guess `NTFY_TOPIC_PREFIX` stays.
3. **Pause:** stops new starts only; running agents finish. `marshall kill` is the per-issue stop.
4. **caffeinate:** wrapped around the daemon inside the plist. No separate agent.
5. **No daily digest.**

Smaller calls made by the implementer (recommendations, not interviewed):

- `marshall stop` = `launchctl bootout gui/$UID/com.jacques.marshall`; `start` = `launchctl bootstrap`. Reboot re-loads the plist, so `RunAtLoad` still satisfies the reboot acceptance test.
- Manual pause is its own flag key (`paused`), not `pause_until`, so a rate-limit resume can never clear a manual pause.
- Kill goes through a flag the daemon's pulse executes (no cross-process race with a live master agent); direct kill+block only when the daemon is down.
- Notify cursor initializes to `MAX(events.id)` on first run (no history blast); a failed POST is retried on later ticks, at most 3 times, then skipped with a log line.

## Premise check against `origin/main` (2026-09-20)

Everything the plan names exists with the shape it assumes, with two additions:

- `claims` has no `title` column, but the push body and the `status` sections need the issue title.
  Migration 005 adds `claims.title`; `finishClaim` writes it from the pickable issue.
  Old rows fall back to the identifier.
- `claude logs <jobId>` exists (`claude --help` names it next to `attach`, `stop`, `rm`), so `marshall logs <identifier>` shells out to it and prints the transcript path as the fallback.
- CI runs on Ubuntu, so every launchctl call sits behind an injectable runner and the tests never touch launchd.

## Build

### 1. `src/notify.ts` + `tests/notify.test.ts`

- `mapEvent(row, claim)` → `Push | null`. Push events and topics:
  - `master.finished`, `master.blocked`, `master.over_budget` → `<prefix>-agent-<slot>` (slot from the claim row).
  - `master.crashed`, `master.rate_limited`, `master.rate_limit_resumed` → `<prefix>-marshall`.
  - Priority header `5`-ish (ntfy `high`) for `blocked`, `over_budget`, `crashed`; default for the rest.
  - Title = `<identifier> <event>`, body = issue title, `Click` header = `https://linear.app/<workspace>/issue/<identifier>` for `finished`/`blocked`, none for rate-limit events.
  - Everything else (phase_changed, stalled, …) returns null — badge-only stays out of ntfy entirely for now.
- `createNotifier({ db, env, log, fetch })` → `{ tick(), stop() }`.
  `tick()` reads `events` rows past the `notify_cursor` flag (reuse `getFlag`/`setFlag`, `src/scheduler/store.ts:268`), joins `claims` for identifier/slot, POSTs, advances the cursor.
  Missing `NTFY_TOPIC_PREFIX` → disabled, one log line, no throw (schema already in `src/config.ts:90`).
- Hook: its own `setInterval` (~10 s) started in `runLoop` (`src/cli/run.ts`) next to the run waiter, stopped in the same `finally`. `--once` runs one notify tick too.
- Tests: mapping table per event type, cursor advance, retry-then-skip, disabled mode. Inject `fetch`; follow the fake-clock style of `tests/scheduler/*`.

### 2. launchd: plist + install scripts

- `scripts/launchd/com.jacques.marshall.plist.template` with `{{BUN}}`, `{{REPO}}`, `{{HOME}}` placeholders:
  `ProgramArguments = /bin/zsh -lc 'exec /usr/bin/caffeinate -i {{BUN}} {{REPO}}/bin/marshall run'`, `KeepAlive` true, `RunAtLoad` true, `WorkingDirectory = {{REPO}}` (so `loadEnv` finds `.env`), stdout/stderr → `~/.marshall/logs/launchd.{out,err}.log`, `ProcessType Background`.
  Same layout as `~/Library/LaunchAgents/com.jacques.branch-janitor.plist`.
- `scripts/install-launchd.sh`: resolve `bun` and the repo path, render the template into `~/Library/LaunchAgents/`, `launchctl bootstrap`. `scripts/uninstall-launchd.sh`: bootout + remove.
- Log rotation: `rotateLog(path, maxBytes = 5 MB, keep = 3)` in `src/log.ts`, called for `marshall.log` and both launchd logs at `runLoop` start.

### 3. CLI (`src/cli/`)

Extend `USAGE` + dispatch in `src/cli/index.ts`; one file per command, matching the existing pattern.

- `status` — keep the current report and add sections (new `src/cli/status-agents.ts` if `status.ts` nears 500 lines):
  **Daemon** (launchctl state), **Agents** (live claims × latest run: slot, identifier, phase, model, elapsed since `claimedAt`), **Queue** (reuse the pickable computation behind `marshall queue`, `src/cli/queue.ts`), **Needs you** (claims in `awaiting_human`/`blocked` with `handoffPath(issueId)` from `src/paths.ts`).
- `start` / `stop` — launchctl bootstrap/bootout wrappers; clear error when the plist isn't installed.
- `pause` / `resume` — set/clear the `paused` flag; extend `isPaused` (`src/caps.ts:80`) to also read it. Scheduler code is otherwise untouched. `pause` prints that running agents finish.
- `kill <identifier>` — write flag `kill:<issueId>`; the master pulse picks it up, interrupts the run (existing interrupt machinery in `src/master/agent.ts`), and calls `block("killed", …, "blocked")`, which lands the `blocked` push through the tailer. Daemon down (launchctl says so) → do it directly in-process: `kill` from `src/runner/launch.ts:101` + `blockIssue` from `src/scheduler/tick.ts:62`.
- `logs [identifier]` — no arg: `tail -f ~/.marshall/logs/marshall.log`. With arg: latest run for the issue → `claude logs` for that job, transcript path printed as fallback.
- `notify test <event>` (undocumented in USAGE header, listed in runbook) — fire one sample push per event type, for the six-pushes acceptance test.

### 4. `docs/runbook.md`

Install/uninstall, start/stop/pause, where state lives (`~/.marshall`), reading logs, resetting a stuck issue by hand (SQL + Linear state), cleaning a slot's Compose project and worktree, the notify test.

Also: update the `NTFY_TOPIC_PREFIX` comment in `.env.example` (no longer "optional until step 09").

## Out of scope

Web dashboard, Tailscale, daily digest, any interrupt-on-pause behavior.

## Verification

1. `bun test`, biome lint, `scripts/check-size.ts` — once at the end.
2. `marshall notify test <event>` for each of the six events → push arrives in the ntfy app (manual, phone in hand).
3. `bash scripts/install-launchd.sh` → `marshall status` shows the daemon up; `marshall stop` / `start` flip it; reboot test when convenient (acceptance: running within a minute, reconcile runs).
4. `marshall pause` → `marshall queue` shows nothing starting; `resume` clears it.
5. Kill path: exercised for real in the step 10 dry run; unit-tested here with a fake runner.
6. Kill any processes started while verifying before reporting done.

PR: branch `feat/step-09-ops` → `main`, concise description, no merge.
