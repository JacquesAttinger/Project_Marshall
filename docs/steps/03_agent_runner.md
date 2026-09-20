# Step 03 — Agent Runner

<!-- Last edited: 2026-09-19 21:55 CDT -->

**TLDR:** The module that starts a Claude agent in the background, watches it, tells the orchestrator when it stops, and can kill or resume it.
It knows nothing about Linear or issues. It only knows sessions.

## Goal

A thin, tested wrapper around `claude --bg` and the Claude daemon's job files, plus a file-append hook sink that receives Claude Code hooks.

## Depends on / parallel with

- Depends on: 01.
- Parallel with: 02, 04, 05.

## Spec references

Sections 4, 6.6, 10.1, 12 of `project_marshall_plan.md`.

## Verified CLI surface (from `claude --help`)

- `claude --bg --name <name> --model <alias> --permission-mode <mode> --max-budget-usd <n> --settings <file-or-json> --append-system-prompt <text> [prompt]` — starts a background session and prints its id.
- `claude agents`, `claude attach <id>`, `claude logs <id>`, `claude stop|kill <id>`, `claude rm <id>`, `claude respawn [id]`.
- `claude --bg --resume <session-id>` — resumes a session in the background.
- Job state: `~/.claude/jobs/<id>/state.json` with keys including `state`, `name`, `cwd`, `sessionId`, `resumeSessionId`, `tempo`, `intent`, `detail`, `output`, `respawnFlags`, `createdAt`, `updatedAt`, `lastTerminalAt`.
- Daemon roster: `~/.claude/daemon/roster.json`.

## In scope

- `launch({name, cwd, prompt, model, systemPromptAppend?, maxBudgetUsd?}) → {jobId, sessionId}`.
- `status(jobId)` — parse `state.json` into a small typed shape: `state`, `sessionId`, `updatedAt`, `tokens` if present.
- `kill(jobId)`, `resume(jobId | sessionId, cwd)`.
- Stall detection: `isStalled(jobId, minutes)` from `updatedAt` and `state`.
- Hook sink: each launch passes a `--settings` JSON whose `SessionStart`, `Stop`, `StopFailure`, `SubagentStop`, `Notification`, and `SessionEnd` hooks run `scripts/hook-sink.sh <MARSHALL_HOME>/events/<runId>.jsonl`. The runner watches that folder and writes the lines into the `events` table.
- A `rateLimited(event)` detector: recognizes the rate-limit error text or stop reason so step 08 can pause the queue.
- Full permissions per the spec: `--permission-mode bypassPermissions` (`skipDangerousModePermissionPrompt` is already true in `~/.claude/settings.json`).

## Out of scope

- Deciding what prompt to send. That is steps 04, 05, 08.
- Worktree creation. That is step 07.

## Reuse (search first)

- `~/.claude/skills/claude-handoff/SKILL.md` — already spawns `claude --bg --name`.
- `~/.claude/hooks/ci-watch-*.sh` — examples of Stop hooks with state files.
- `cmux` hooks on `PushNotification`, `Stop`, `Notification` for the hook payload shapes.
- Claude Code hooks docs: HTTP hooks (`"type": "http"`), payload fields `session_id`, `cwd`, `transcript_path`, `last_assistant_message`, `stop_reason`.

## Deliverables

- `src/runner/` (`launch.ts`, `status.ts`, `events.ts`, `settings.ts`, `types.ts`, `index.ts`), `agent-settings.json`, `scripts/hook-sink.sh`, `src/db/migrations/002_runs.sql`.
- `tests/runner/*.test.ts` — fixture-driven, run in CI with a fake `claude` shim.
- `tests/runner.live.test.ts` — gated by `MARSHALL_LIVE=1`; launches a trivial agent ("print hello, then stop"), waits for the `Stop` hook, checks `status`, kills a second one mid-run, resumes the first.
- `docs/runner.md` — the exact command line used, and the `state.json` values seen for each lifecycle state.

## Acceptance criteria

- Launch → `Stop` hook lands in the events file within the run → `status` shows a terminal state.
- `kill` on a running job leaves `state.json` in a terminal state and no orphan process.
- `resume` on a stopped job continues the same session (the agent remembers the prior turn).
- `isStalled` returns true for a live job whose transcript mtime and newest hook event are older than the threshold.
- A forced rate-limit error (or a replayed payload) is classified by `rateLimited`.

## Decisions (grilled 2026-09-19)

Full plan: [`../step_03_agent_runner_plan.md`](../step_03_agent_runner_plan.md).

| # | Question | Decision |
|---|---|---|
| 1 | Hook transport | File-append command hook. Each hook runs `scripts/hook-sink.sh <MARSHALL_HOME>/events/<runId>.jsonl`. The runner watches the folder. No HTTP server, no port. Supersedes the "HTTP hooks" wording in spec decision #17; the intent (agent → orchestrator signaling without polling) is kept. |
| 2 | Settings isolation | Isolate. Every launch passes `--setting-sources project,local` so `~/.claude/settings.json` does not leak into agents. A committed `agent-settings.json` carries what agents need; the runner merges the per-run hooks into it and passes the result as inline `--settings` JSON. |
| 3 | After the turn ends | Runner auto-stops. On `finished` (a `Stop` with empty `background_tasks`) or `StopFailure`, the runner runs `claude stop <jobId>`, then emits the event. Resume always targets a stopped session. |
| 4 | Status source of truth | Three sources. Liveness: `claude agents --json --all`. Progress: transcript mtime and newest hook event. Ids and timestamps: `state.json`. `updatedAt` moves only on state transitions, so it is not used for stalls. |
| 5 | Test strategy | Two tiers. Fixture-driven unit tests run in CI with a fake `claude` shim on `PATH`. A live smoke test gated by `MARSHALL_LIVE=1` runs the acceptance criteria against the real daemon. |
| 6 | Model alias | The caller passes `model` (`opus`, `fable`, `haiku`) and optional `effort`; the runner passes them through. `fable` resolves via `env.ANTHROPIC_DEFAULT_FABLE_MODEL` in `agent-settings.json`. |
| 7 | Rate limit | `StopFailure` with `error: "rate_limit"`. The `output` field is not needed. |

Answered by reading the CLI: hooks fire in `--bg` sessions (cmux relies on it); `--dangerously-skip-permissions` is an alias for `--permission-mode bypassPermissions`; `updatedAt` moves only on state transitions.
