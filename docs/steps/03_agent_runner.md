# Step 03 — Agent Runner

<!-- Last edited: 2026-09-19 21:15 CDT -->

**TLDR:** The module that starts a Claude agent in the background, watches it, tells the orchestrator when it stops, and can kill or resume it.
It knows nothing about Linear or issues. It only knows sessions.

## Goal

A thin, tested wrapper around `claude --bg` and the Claude daemon's job files, plus an HTTP endpoint that receives Claude Code hooks.

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
- Hooks endpoint: `Bun.serve` on `127.0.0.1:<port>` that accepts HTTP hooks for `Stop`, `SessionEnd`, `Notification`, and `SubagentStop`. Each launch passes a `--settings` JSON that points those hooks at the endpoint with the job name in the URL. Events land in the `events` table.
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

- `src/runner.ts`, `src/hooks-server.ts`, `src/hook-settings.ts` (builds the `--settings` JSON).
- `tests/runner.test.ts` — launches a trivial agent ("print hello, then stop"), waits for the `Stop` hook, checks `status`, kills a second one mid-run.
- `docs/runner.md` — the exact command line used, and the `state.json` values seen for each lifecycle state.

## Acceptance criteria

- Launch → `Stop` hook arrives at the endpoint within the run → `status` shows a terminal state.
- `kill` on a running job leaves `state.json` in a terminal state and no orphan process.
- `resume` on a stopped job continues the same session (the agent remembers the prior turn).
- `isStalled` returns true for a job whose `updatedAt` is older than the threshold.
- A forced rate-limit error (or a replayed payload) is classified by `rateLimited`.

## Open questions for grilling

1. Do hooks fire for `--bg` sessions the same way as interactive ones? Verify before building on it.
2. `bypassPermissions` vs `--dangerously-skip-permissions`: which does `--bg` accept?
3. Is `updatedAt` in `state.json` touched on every tool call, or only on state changes? If only state changes, stall detection needs the transcript file's mtime instead.
4. Hooks over HTTP, or a shell hook that appends to a file the orchestrator tails? HTTP is cleaner; a file survives an orchestrator restart.
5. Should the runner own the `claude --model` alias mapping (`opus`, `fable`, `haiku`), or the caller?
6. What does the job `output` field contain, and is it enough to detect the rate-limit case?
