# Iteration 1 — Build Steps

<!-- Last edited: 2026-09-19 21:15 CDT -->

**TLDR:** Iteration 1 is split into 10 steps.
Each step is one Markdown file that one agent can carry out.
Grill each file, then implement it.
Steps in the same wave do not touch the same code, so they can run in parallel.

Source spec: [`../project_marshall_plan.md`](../project_marshall_plan.md).

## Dependency graph

```
01 scaffold
 ├── 02 linear client ──┐
 ├── 03 agent runner ───┤
 ├── 04 planning phase ─┤
 └── 05 implement+review┤
                        ├── 06 hand-off package
                        ├── 07 queue + scheduler
                        └──────── 08 master agent (integration)
                                   └── 09 ops: launchd, ntfy, CLI
                                        └── 10 end-to-end dry run
```

## Waves

| Wave | Steps | Parallel? | Notes |
|---|---|---|---|
| 1 | 01 | No | Small. Everything else imports from it. |
| 2 | 02, 03, 04, 05 | **Yes, all four** | 02 and 03 are code. 04 and 05 are skills and prompts. They share no files. |
| 3 | 06, 07 | **Yes, both** | 06 needs 02. 07 needs 02. Neither needs 03–05 to compile, only their interfaces. |
| 4 | 08 | No | Wires 03–07 together. |
| 5 | 09 | Partly | The ntfy client and launchd plist can start in wave 2. Final wiring needs 08. |
| 6 | 10 | No | Runs the real thing on ChessBuddy. |

## Files

| Step | File | One line |
|---|---|---|
| 01 | [`01_scaffold.md`](01_scaffold.md) | Repo, runtime, config, SQLite, logging, pre-commit, CLI skeleton |
| 02 | [`02_linear_setup_and_client.md`](02_linear_setup_and_client.md) | ChessBuddy workspace setup + a Linear client module |
| 03 | [`03_agent_runner.md`](03_agent_runner.md) | Launch, watch, kill, and resume `claude --bg` sessions; hooks endpoint |
| 04 | [`04_planning_phase.md`](04_planning_phase.md) | Haiku complexity classifier + autonomous `marshall-plan` skill |
| 05 | [`05_implement_and_review_phase.md`](05_implement_and_review_phase.md) | `marshall-implement` skill: `ship-plan` + Compose isolation + `code-review` loop |
| 06 | [`06_handoff_package.md`](06_handoff_package.md) | The orientation + recipe package, posted to Linear, PR, and file |
| 07 | [`07_queue_and_scheduler.md`](07_queue_and_scheduler.md) | Poll, order, caps, cadence, overlap check, claim, reconcile |
| 08 | [`08_master_agent_state_machine.md`](08_master_agent_state_machine.md) | Per-issue lifecycle: phases, bounces, timeouts, resumes, rate-limit pause |
| 09 | [`09_ops_launchd_notifications_cli.md`](09_ops_launchd_notifications_cli.md) | launchd, caffeinate, ntfy push, `marshall status`, runbook |
| 10 | [`10_e2e_dry_run.md`](10_e2e_dry_run.md) | Seed real issues, run for a day, tune, define "proven" |

## How to use a step file

1. Run `/grilling` on the file. Answer its "Open questions" section first.
2. Update the file with the decisions.
3. Implement in a worktree with `/ship-plan docs/steps/<file>`.
4. Tick the acceptance criteria before opening the PR.
