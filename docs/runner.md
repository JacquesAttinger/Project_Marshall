# Agent runner — observed behaviour

<!-- Last edited: 2026-09-20 12:50 CDT -->

**TLDR:** This page records what the real `claude` daemon did when the runner drove it on 2026-09-19 (Claude Code 2.1.278).
It shows the exact command line, what `claude agents --json` and `state.json` say in each lifecycle state, and the facts that changed the design during the live test.
Re-run `MARSHALL_LIVE=1 bun test tests/runner.live.test.ts` to check these against a newer CLI.

## Command line

`launch()` runs, from the agent's `cwd`:

```
claude --bg --name <name> [--resume <sessionId>] --model <model> [--effort <effort>] \
  --permission-mode bypassPermissions --setting-sources project,local --strict-mcp-config \
  --settings '<agent-settings.json + per-run hooks>' \
  [--append-system-prompt <text>] [--max-budget-usd <n>] [...extraArgs] <prompt>
```

The binary is `MARSHALL_CLAUDE_BIN`, else the first `claude` on `PATH` whose directory is not a `cmux-cli-shims` folder.
The cmux shim rewrites `claude stop <id>` into a prompt (the agent answers "Stopped. Nothing is running"), so it must be skipped.
The shim's own hook injection is not needed: agents get their hooks from `--settings`.
`--strict-mcp-config` drops the claude.ai connectors (Linear, Gmail, Slack, Calendar) that otherwise load in every session authenticated with the claude.ai login, whatever `--setting-sources` says; agents must never reach Linear through the personal account.
The spawned process also loses `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, and git's repo-location variables (`GIT_DIR`, `GIT_INDEX_FILE`, ...), so a nested launch is accepted and an agent started from a git hook commits to its own worktree.
`LaunchOpts.runId` lets a caller mint the run id first (`mintRunId`) and name files after it before the launch; the planner's brief is `~/.marshall/briefs/<runId>.md`.

`--settings` is `agent-settings.json` plus one command hook per event in `SessionStart`, `Stop`, `StopFailure`, `SubagentStop`, `Notification`, `SessionEnd`.
Each hook runs `scripts/hook-sink.sh <MARSHALL_HOME>/events/<runId>.jsonl` and the sink appends `{"received_at": ..., "event": <payload>}` on one line.
`LaunchOpts.env` is merged into the settings `env` block, so it applies to every Bash call the agent makes.

With `LaunchOpts.statusFile`, the `Stop` hook gets that path as a second argument and the sink runs `scripts/stop-guard.ts` on it.
A `Stop` with no background tasks while the file has `outcome: null` (or does not exist yet) is **blocked**: the hook prints `{"decision":"block","reason":...}`, Claude Code sends the agent back to work, and the events line carries `"stop_blocked": true` so `classify()` does not treat it as terminal.
At most 3 blocks per status file (`<statusFile>.stop-blocks` counts them); after that the stop goes through and the orchestrator sees a run that ended with no outcome.
This exists because a skill that calls another skill (`/marshall:implement` → `/marshall:review`) can end its turn on the inner skill's report; observed on 2026-09-20, run `che-5-1d34b0a8`.

`claude --bg` returns in about 0.8 s and prints `Started background session <8 hex>`; the first 8-hex token is the job id.
The job id is the first 8 characters of the session id.

## Lifecycle, as seen from the three sources

| State | `claude agents --json` entry | `state.json` | Hook file |
|---|---|---|---|
| Just launched | `state: working`, `pid` present, `sessionId` set | `state: working`, `sessionId` set, `updatedAt == createdAt + 0.6 s`, `firstTerminalAt: null` | `SessionStart` within 1 s |
| Mid-turn | `state: working`, `pid` present | `state: working`, `tokens` growing, `updatedAt` moved once on start | tool-call progress is only visible in the transcript mtime |
| Turn ended, session idle | `state: done`, `pid` present, `status: idle` | `state: done`, `output: {result}`, `firstTerminalAt == lastTerminalAt == updatedAt` | `Stop` with `background_tasks: []`; `Notification idle_prompt` after 60 s |
| After `claude stop` (runner auto-stop or `kill`) | `state: done` or `stopped`, **no `pid`**, no `status` | `state: done` (finished turn) or `stopped` (killed mid-turn) | `SessionEnd` |
| Resumed | new entry, new id, `state: working` | new `state.json` with a **new** `sessionId` | `SessionStart` for the new session |

Key facts:

- **Liveness is `pid`, not `state`.** The daemon flips `state` to `done` the moment the turn ends, while the process stays resident and idle. `pid` and `status` are present only while the process is alive. `RunStatus.alive` is therefore "runner state not terminal and the roster entry has a `pid`".
- **`updatedAt` moves only on state transitions.** It is useless for stall detection. `isStalled` uses `max(transcript mtime, newest hook event)`.
- **`--bg --resume <sessionId>` on a stopped session forks it.** The new job has a new job id and a new session id; the conversation carries over (the resumed agent answered "hello" when asked what it printed earlier). `runs.resumed_from` keeps the old session id; `runs.session_id` is filled by the new `SessionStart` hook.
- **Killing mid-turn** leaves `state.json.state = stopped` with `firstTerminalAt` set, the roster entry without a `pid`, and a `SessionEnd` hook line. The process is gone within a second (`kill -0` fails).
- **The transcript slug uses the real path.** On macOS `tmpdir()` is `/var/...`, a symlink to `/private/var/...`; the daemon and the transcript directory use the latter. `transcriptPath()` calls `realpathSync` first.
- **Hooks fire in `--bg` sessions** with `--setting-sources project,local`: the six events above all arrived. `Stop` does not fire on API errors; `StopFailure` does (not observed live; covered by the fixture `tests/fixtures/hooks/stop-failure-rate-limit.json` from the hooks docs).

## Observed values (2026-09-19, haiku, effort low)

Launched:

```json
{ "id": "94865df2", "pid": 96537, "kind": "background", "state": "working",
  "sessionId": "94865df2-64b6-4b14-9b1e-91b9cef86cc5", "name": "marshall-live-1" }
{ "state": "working", "sessionId": "94865df2-…", "createdAt": "2026-09-20T03:10:53.226Z",
  "updatedAt": "2026-09-20T03:10:53.838Z", "firstTerminalAt": null }
```

Finished and auto-stopped (5 s after launch):

```json
{ "id": "94865df2", "pid": null, "state": "done" }
{ "state": "done", "tokens": 45, "output": { "result": "hello" },
  "updatedAt": "2026-09-20T03:10:58.207Z", "firstTerminalAt": "2026-09-20T03:10:58.207Z",
  "lastTerminalAt": "2026-09-20T03:10:58.207Z" }
```

Killed mid-turn (10 s into a counting loop):

```json
{ "id": "81803cf5", "pid": null, "state": "stopped" }
{ "state": "stopped", "tokens": 678, "updatedAt": "2026-09-20T03:11:10.050Z",
  "firstTerminalAt": "2026-09-20T03:11:10.050Z", "lastTerminalAt": "2026-09-20T03:11:10.050Z" }
```

Resumed from `94865df2-…`:

```json
{ "runId": "marshall-live-3-…", "jobId": "dac88bb1", "sessionId": "dac88bb1-e454-419e-9ddd-d7b74cef38a2",
  "resumedFrom": "94865df2-64b6-4b14-9b1e-91b9cef86cc5", "state": "finished" }
{ "state": "done", "sessionId": "dac88bb1-…", "tokens": 86, "output": { "result": "hello" } }
```

## Running the live test

```bash
MARSHALL_LIVE=1 bun test tests/runner.live.test.ts
```

It uses the real `~/.claude`, a temp `MARSHALL_HOME`, a temp directory as the agent's cwd, and `haiku` at low effort (`MARSHALL_LIVE_MODEL` overrides).
It takes about 30 s, starts four jobs, and removes them from the roster at the end.
Set `MARSHALL_LIVE_REPORT=<path>` to dump the observed values above as JSON.
CI never runs it: `bun test` skips it when `MARSHALL_LIVE` is unset.
