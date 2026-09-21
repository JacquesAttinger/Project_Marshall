# Master agent — state machine

<!-- Last edited: 2026-09-21 01:50 CDT -->

**TLDR:** One `MasterAgent` per claimed issue runs plan → implement → hand-off and then parks the claim while a human looks at the PR.
Every state is a value of `claims.state`, so a restart of the orchestrator rebuilds each agent from its row.
The pulse, which runs before every scheduler tick, is what enforces the clock, catches stalls, wakes rate-limited agents, and rebases parked PRs when a sibling merges.
Every failure path ends in exactly one terminal state with exactly one terminal event.

## States

```
                 hooks.start (fresh or bounce)
                          │
                          ▼
   claimed ──────────► planning ──────► implementing ──────► handoff ──────► awaiting_human
                          │                  │                  │                 │   ▲
                          │ rate limit       │ rate limit       │ rate limit      │   │ CI green, badge re-posted
                          ▼                  ▼                  ▼                 ▼   │
                     rate_limited        rate_limited       rate_limited       rebasing ──► resolving
                     (pause ends → back to the same phase)                        │            │
                                                                                  │            │ resolver green, CI green
   any phase ─── 2-hour clock ─────────────────────────────────► blocked          └────────────┘
   any phase ─── resumes and the fresh restart used up ────────► blocked
   implement ─── review_exhausted / tests_red / blocked ───────► blocked
   any phase ─── orchestrator crash inside the driver ─────────► blocked (event: crashed)
   awaiting_human / rebasing ─── PR merged or closed ──────────► released
   resolving ─── resolver fails or gives up ───────────────────► blocked
```

| State | Holds a slot | Who moves it on | Written by |
|---|---|---|---|
| `claiming`, `claimed` | yes | the scheduler (step 07) | `src/scheduler/tick.ts` |
| `planning` | yes | `runPlanPhase` returns | `src/phases/plan.ts` |
| `implementing` | yes | the implement run's `Stop` and `implement.json` | `src/phases/implement.ts` |
| `handoff` | yes | `runHandoffPhase` returns | `src/phases/handoff.ts` |
| `rate_limited` | yes | the pulse, when `pause_until` has passed | `MasterAgent.pauseForRateLimit` |
| `awaiting_human` | **no** | a human (merge, close, bounce) or a sibling merge | `src/phases/handoff.ts`, `src/phases/rebase.ts` |
| `rebasing` | **no** | CI on the rebased push | `src/phases/rebase.ts` |
| `resolving` | yes (re-taken) | the resolver run's `Stop` and `resolve.json` | `src/phases/rebase.ts` |
| `blocked` | no | a human moving the issue back to Todo | `blockIssue` |
| `released` | no | a human moving the issue back to Todo (a bounce) | `src/phases/rebase.ts`, reconcile |

The slot rule is the partial index `claims_live_slot` (migration 004): every state not in `released`, `blocked`, `awaiting_human`, `rebasing` holds one.
`TERMINAL_CLAIM_STATES` in `src/scheduler/types.ts` is the same list.

## The three ways in

| Entry | Called by | What the driver does |
|---|---|---|
| `start` | the scheduler after a claim and a worktree | fresh: plan from scratch. Bounce (`bounces > 0`): plan in revise mode with the stored model and plan path, then implement on the same branch with `implement.json` reset to a resume point so the PR is reused, then a new hand-off round. |
| `resume` | reconcile, for a claim whose agent died, after counting the resume | implementing: kill the dead run's row, continue its session. planning / handoff: run the phase again. |
| `attach` | reconcile, for a claim it kept (agent alive, or parked) | planning / implementing / handoff: wait on the live run (`attachRunId`) instead of launching another. `rate_limited`: pause again from the recorded reset time. `awaiting_human` / `rebasing` / `resolving`: nothing to build; the pulse owns them from the table. |

The phase a claim is in comes from `phaseFor(claim)`: the state itself when it is a phase, else planning for a row the scheduler just handed over, else planning / implementing / handoff by whether `plan_path` and `pr_url` are set yet.

## The pulse

`startLoop` calls `hooks.pulse()` before every tick, paused or not (`src/scheduler/index.ts`).
First the kill flags: a `kill:<issueId>` row in `flags` (written by `marshall kill`) whose agent is waiting on a run or a rate-limit pause is executed like the clock, with `killed` as the interrupt, and the phase lands in `blocked` with `why: killed`; a flag whose agent sits between runs waits for the next pulse; one with no agent is cleared.
Then, for each live agent, in this order:

1. **Clock.** `claimedAt + issueTimeoutHours` has passed → kill the run, settle its wait with `over_budget`, the phase ends in `blocked` with the event `over_budget`.
2. **Rate-limit wake.** The agent is waiting in `rate_limited` and `pause_until` has passed → the pause flag is cleared, the state goes back to the phase, `rate_limit_resumed` is written, and the phase probes by continuing the same session. A second rate limit pauses again without spending a resume.
3. **Stall.** `runner.isStalled(run, stallMinutes)` → `stalled`, kill, settle the wait with `stalled`. The implement phase then resumes the session (up to `maxResumes`), then discards the branch back to the plan commit and starts the phase fresh once (`fresh_restart`, only with 20 minutes or more left on the clock), then blocks. The plan and hand-off phases get the fresh retry directly.

Then the rebase machinery, over the claims table (`src/phases/rebase.ts`):

4. **Merge poll.** One `gh pr view --json mergedAt,state,statusCheckRollup` per parked PR. Merged → `released` + `pr_merged`, and every other parked PR gets `rebase_after` = the merged PR (`rebase_queued`). Closed → `released` + `pr_closed`.
5. **The one in flight.** At most one claim is `rebasing` or `resolving`. Rebasing: CI green → hand-off re-posted with the badge `rebased after <PR>` → `awaiting_human` + `rebased`; CI red → a resolver if a slot is free. Resolving: the run's `Stop` → `resolve.json` says `green` and CI agrees → same landing; anything else → `blocked`, with the worktree put back to the pushed tip.
6. **The next one.** No claim in flight → the oldest `awaiting_human` with `rebase_after`: `git fetch`, `git rebase origin/<base>`, `git push --force-with-lease` → `rebasing`. A conflict → `rebase_conflict`, then a resolver run (`/marshall:resolve-conflicts <plan> <ID> conflict`) if `lowestFreeSlot` finds one; else `git rebase --abort` and the same claim is tried next tick.

A resolver takes a concurrency slot through the partial index but writes no `starts` row: it counts against `maxAgents`, never against the daily or window caps.

## Events

All rows in `events` with `type = master.<name>`.
Step 09 maps `finished`, `blocked`, `over_budget`, `crashed`, `rate_limited`, `rate_limit_resumed` to pushes.

| Event | When | Payload |
|---|---|---|
| `phase_changed` | every state write | `from`, `to`, plus the transition's detail (`mode`, `until`, `badge`, `slot`, ...) |
| `finished` | the hand-off is posted and the issue is in Needs Verification | `prUrl`, `handoffPath`, `round`, `followups` (count filed) |
| `followup_filed` | one per follow-up issue created, so a bounce never files a title twice | `title`, `identifier`, `url` |
| `blocked` | terminal: the implementer gave up (`review_exhausted`, `tests_red`, `blocked`), the resumes and the fresh restart are spent (`exhausted`), a phase failed for good, or a rebase could not be recovered | `why`, `bounces`, `branch` |
| `over_budget` | terminal: the 2-hour clock | same as `blocked` |
| `crashed` | terminal: the driver threw | same as `blocked` |
| `stalled` | the pulse killed a run with no activity for `stallMinutes` | `runId`, `state` |
| `resumed` | a session was continued | `runId`, `resumes`, `why` or `how: boot` |
| `fresh_restart` | the branch was reset to the plan commit and the phase relaunched | `phase`, `why`, `resetTo` |
| `rate_limited` | a run ended with `StopFailure rate_limit` | `until`, `parsed` (true when "Resets at" was read), `details` |
| `rate_limit_resumed` | the pause ended and the phase probed | — |
| `pr_merged`, `pr_closed` | the merge poll saw it | `prUrl` |
| `rebase_queued` | a sibling merged | `after` |
| `rebased` | the rebased PR is green and re-posted | `badge`, `posted`, `requeued` |
| `rebase_conflict` | the inline rebase conflicted, or CI went red after it | `kind: conflict \| ci_red`, `after` |

## Limits, and where each one lives

| Limit | Value | Enforced in |
|---|---|---|
| Issue clock | `issueTimeoutHours` (2) from `claimed_at`; a bounce restarts it | `MasterAgent.checkClock`, and before every launch |
| Stall | `stallMinutes` (5) with no transcript or hook activity | `MasterAgent.checkStall` → `runner.isStalled` |
| Resumes | `maxResumes` (2) per lifecycle, shared with reconcile's boot resumes | `claims.resumes`, `src/phases/implement.ts` |
| Fresh restart | one per lifecycle, and only with 20 minutes or more left | `claims.fresh_restarts`, `MasterAgent.canFreshRestart` |
| Fix cycles | `maxFixCycles` (4) | inside `/marshall:implement`; this step only reads `implement.json` |
| Rate limit | parsed "Resets at", else `rateLimitProbeMinutes` (30) | `src/master/ratelimit.ts`, the `pause_until` flag |
| Bounces | `maxBounces` (3) | the scheduler (step 07) |

## Files the phases leave behind

- `~/.marshall/issues/<ID>/implement.json` — the implementer's status. A bounce or a fresh restart with an existing PR rewrites it to `outcome: null, phase: starting, cycle: 0` with the PR kept, which the skill reads as "resume, reuse the PR". Without a PR it is removed.
- `~/.marshall/issues/<ID>/resolve.json` — the resolver's status: `outcome: green | blocked`, `reason`.
- `~/.marshall/handoffs/<ID>.md` and `.json` — the package and its sidecar (step 06); a rebase re-post edits the same Linear comment.
- The claim row: `identifier`, `plan_path`, `model`, `pr_url`, `fresh_restarts`, `rebase_after`.

## Running it

`bin/marshall run` rotates the logs, writes the pidfile, reconciles, then loops: pulse, tick, sleep `pollSeconds`; the ntfy tailer ticks every 10 s beside it.
`bin/marshall run --once` does one reconcile, one pulse, one tick, and one notify tick, prints the decisions, and exits.
Ctrl-C stops the loop; live agent jobs keep running under the Claude daemon, and the next start's reconcile attaches to them.
launchd, the pushes, and the control commands are in [`runbook.md`](runbook.md); the first real run on ChessBuddy is step 10.
