# Project Marshall

<!-- Last edited: 2026-09-21 03:05 CDT -->

**TLDR:** Marshall watches a Linear board and runs Claude Code agents on the issues.
Iteration 1 is a Linear autopilot for one repo (ChessBuddy) on a laptop.
So far: runtime, config, SQLite, logging, CLI, quality gates, the Linear client, the agent runner (`src/runner/` launches `claude --bg` sessions, learns when they stop, and can kill or resume them), the planning phase (`src/plan/` classifies an issue, launches the `/marshall:plan` agent, and checks its plan file), the implement phase (`/marshall:implement` and `/marshall:review` in the plugin; `src/isolation.ts` keeps two agents' Docker stacks apart), the hand-off phase (`src/handoff/` runs the `/marshall:handoff` writer, checks its six-section package, and posts it to Linear and the PR body), the scheduler (`src/scheduler/` polls Linear, checks the caps, claims, makes the worktree, and cleans up after a crash), and the master agent (`src/master/` and `src/phases/` drive one issue through plan → implement → hand-off, enforce the clock, the stall resumes, and the rate-limit pause, and rebase parked PRs when a sibling merges).

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
| `bin/marshall linear setup [--json]` | Create the Linear states and labels Marshall needs. Idempotent. Refuses a key from another workspace. |
| `bin/marshall plan <identifier> --cwd <worktree> [--revise] [--json]` | Plan one issue in an existing worktree: classify, launch the planner, verify, post to Linear. |
| `bin/marshall plan check <file>` | Check a plan file for the required sections, in order. |
| `bin/marshall handoff check <file>` | Check a hand-off file: six sections in order, the section 5 sub-lists, a PR URL and a branch in section 6. |
| `bin/marshall queue [--json]` | Dry-run one scheduler tick: the ordered pickable list and why each issue would or would not start now. Never writes. |
| `bin/marshall run [--once]` | The orchestrator: reconcile, then poll Linear and drive the master agents until Ctrl-C. `--once` does one reconcile + pulse + tick and exits. |
| `MARSHALL_LINEAR_E2E=1 bun test tests/linear.e2e.test.ts` | Run the real-workspace Linear test. Skipped otherwise. |
| `MARSHALL_LIVE=1 bun test tests/plan.live.test.ts` | Classify the five sample issues with the real Haiku. Skipped otherwise. |
| `MARSHALL_LIVE=1 MARSHALL_LIVE_HANDOFF_CWD=<worktree> bun test tests/handoff.live.test.ts` | Run the real hand-off writer against a worktree with an open PR. Posts nothing. Skipped otherwise. |
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

`plugin/` is a Claude Code plugin named `marshall` (`plugin/.claude-plugin/plugin.json`).
Agents launch with `--setting-sources project,local`, which never loads `~/.claude/skills/`, so every skill an agent needs lives under `plugin/skills/` here and is loaded per launch with `--plugin-dir <repo>/plugin`.
It is not the repo root because a plugin root's `bin/` goes on the agent's `PATH`, and `bin/marshall` is not for agents.

| Skill | Does |
|---|---|
| `/marshall:plan <brief>` | The autonomous planner; see [`docs/planning.md`](docs/planning.md). |
| `/marshall:implement <plan-path> <ISSUE-ID>` | Plan → commits → local gate → PR → CI → `/marshall:review` → fixes, up to `maxFixCycles` times. Writes `~/.marshall/issues/<ISSUE-ID>/implement.json` at every step (`src/implement/status.ts` has the schema). Always ends with a PR; a red run leaves a draft whose body starts with `## Still failing`. |
| `/marshall:review <plan-path>` | The built-in `/code-review` bug hunt plus a Spec pass against the plan. `CONFIRMED` findings and spec gaps block; `PLAUSIBLE` ones are notes. |
| `/marshall:handoff <plan-path> <ISSUE-ID>` | The read-only hand-off writer: six sections from the plan, the diff, and the PR into `~/.marshall/handoffs/<ISSUE-ID>.md`; see [`docs/handoff.md`](docs/handoff.md). |
| `/marshall:resolve-conflicts <plan-path> <ISSUE-ID> <conflict\|ci>` | After a sibling PR merged: finish the rebase the orchestrator started (conflict mode) or fix the red CI it left (ci mode), then the full done gate. Reports through `~/.marshall/issues/<ISSUE-ID>/resolve.json`. |

`bun scripts/launch-implement.ts --cwd <worktree> --plan docs/x_plan.md --issue CB-12 --slot 0 --watch` starts one implement run by hand, outside the orchestrator.
Each slot gets its own Compose project name and host ports; see [`docs/isolation.md`](docs/isolation.md).
`bun scripts/launch-handoff.ts --cwd <worktree> --plan docs/x_plan.md --issue CB-12 [--post]` runs the hand-off writer on a finished branch, and with `--post` sends the package to Linear and the PR.

## Scheduler

`src/scheduler/` is the loop that decides when work starts (step 07).
`startLoop` reconciles once, then ticks every `pollSeconds`.
A tick lists the pickable issues (Todo, assigned to me), orders them by priority then age, and for each one in turn:

1. Skips it while a claim row is still live, or blocks it when it has bounced `maxBounces` times.
2. Checks the caps in `src/caps.ts`: `maxAgents` live claims, `dailyStartCap` starts on the local calendar day, `windowStartCap` starts in the last `windowHours`.
   A bounce or a resume only faces the concurrency cap.
   While `pause_until` (the `flags` table) is in the future, nothing starts.
3. Writes a `claiming` row, claims in Linear, creates the worktree (`src/worktree.ts`, a sibling `<repo>-<branch>` off `origin/<baseBranch>` with `.env` copied in), records a `starts` row for a first-time start, and calls `hooks.start(claim, issue)`.

Reconcile, on boot, walks every live claim: a `claiming` orphan and a dead claim out of resumes go back to Todo; a dead claim with budget goes through `hooks.resume`; a live one, and every parked one (a PR waiting on a human, a rebase waiting on CI, a rate-limit pause), is kept and handed to `hooks.attach`.
A start that fails after Linear said yes parks the issue in `Blocked` with the reason; moving it back to Todo retries it with a fresh bounce budget.
`bin/marshall queue` shows exactly what the next tick would do.

## Master agent

`src/master-agent.ts` supplies the hooks the loop takes (step 08): one `MasterAgent` per claim, plus a `pulse` the loop runs before every tick.
The driver runs `runPlanPhase` → `/marshall:implement` → `runHandoffPhase`, moves the issue to Needs Verification, files the follow-ups (only with `fileFollowUps: true`; off by default), and parks the claim in `awaiting_human`, which frees the slot while the worktree stays for rebases and bounces.
The pulse enforces the 2-hour clock, kills and resumes a stalled run (two resumes, then one fresh restart from the plan commit, then Blocked), wakes a rate-limited agent when the pause ends, and, for every parked PR, polls for a merge: when one lands, the others are rebased one at a time, re-posted with a `rebased after <PR>` badge when green, or handed to `/marshall:resolve-conflicts` in a free slot on a conflict or red CI.
Every state is on the claims row, so `bin/marshall run` after a crash reconciles and continues from where each issue was.
See [`docs/state_machine.md`](docs/state_machine.md) for the diagram, the events, and where each limit lives.

## Docs

- [`docs/project_marshall_plan.md`](docs/project_marshall_plan.md) — the spec.
- [`docs/steps/`](docs/steps/) — iteration 1 build steps.
- [`docs/linear_setup.md`](docs/linear_setup.md) — what is configured in Linear and why.
- [`docs/runner.md`](docs/runner.md) — agent runner: command line, lifecycle states, live-test facts.
- [`docs/planning.md`](docs/planning.md) — planning phase: the brief, the skill, the classifier, the post-run checks.
- [`docs/isolation.md`](docs/isolation.md) — slot → Compose project → ports, and how the env reaches an agent.
- [`docs/handoff.md`](docs/handoff.md) — hand-off phase: the writer, the validation rules, the Linear comment, the PR-body splice, the sidecar.
- [`docs/handoff_template.md`](docs/handoff_template.md) — what each of the six hand-off sections is for.
- [`docs/step_07_queue_scheduler_plan.md`](docs/step_07_queue_scheduler_plan.md) — scheduler: decisions, tick order, reconcile.
- [`docs/state_machine.md`](docs/state_machine.md) — master agent: states, the three ways in, the pulse, events, limits.
- [`docs/step_08_master_agent_plan.md`](docs/step_08_master_agent_plan.md) — master agent: decisions and the premise check against the code.
- [`plugin/README.md`](plugin/README.md) — the skills agents run, and how to try them by hand.
