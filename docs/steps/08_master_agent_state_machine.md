# Step 08 — Master Agent State Machine

<!-- Last edited: 2026-09-19 21:05 CDT -->

**TLDR:** The brain for one issue.
It runs plan → implement → review → hand-off, watches the clock, restarts a stuck agent, and knows when to give up and call me.
This is the step that wires 03 through 07 together.

## Goal

One `MasterAgent` class per claim that drives the phases in order, enforces every limit in the spec, and emits events the notifier and dashboard read.

## Depends on / parallel with

- Depends on: 03, 04, 05, 06, 07.
- Parallel with: nothing. This is the integration step.

## Spec references

Sections 5.1, 5.2, 6.6, 7, 10.2 of `project_jarvis_plan.md`.

## In scope

### States

`Claimed → Planning → Implementing → Reviewing → PR Open → Awaiting Human` and `Released`.
Failure states: `Blocked`, `Stalled`, `Over Budget`, `Rate Limited`.

### Phases

- **Planning:** `classify()` → pick model → `runner.launch` with `/jarvis-plan <issue>` in the worktree. Done when the `Stop` hook arrives and the plan file validates.
- **Implementing + Reviewing:** `runner.launch` with `/jarvis-implement <plan> <issue> <slot>`. Done when the `Stop` hook arrives and a PR URL exists. `REVIEW_EXHAUSTED` → `Blocked`.
- **Hand-off:** run the hand-off writer, `handoff.post()`, move the issue to Needs Verification, file `followups.json` via `linear.createFollowUp`, emit `finished`.
- **Bounce:** on pickup of an issue with an existing branch, skip Planning, read the latest human comment, and launch `/jarvis-implement` with the comment as the instruction. Rewrite the hand-off at the end.

### Limits

- Issue clock: 2 hours from claim across all phases. On expiry: kill, emit `over_budget`, mark Blocked.
- Stall: `runner.isStalled(job, 5)` → `runner.resume`. Count resumes. After 2: discard the branch, restart the current phase fresh once. If that also fails: Blocked.
- Fix cycles: enforced inside `jarvis-implement` (4). This step only reads the result.
- Rate limit: `runner.rateLimited(event)` → set the scheduler pause flag, keep the claim, emit `rate_limited`. On the next 5-hour boundary (or a config delay), resume the job and clear the flag, emit `rate_limit_resumed`.
- Crash of the orchestrator: state is in the `claims` row, so a restart plus step 07's reconcile can rebuild the object and continue.

### Events

`phase_changed`, `finished`, `blocked`, `over_budget`, `stalled`, `resumed`, `rate_limited`, `rate_limit_resumed`, `crashed`.
Written to the `events` table; step 09 maps them to pushes.

## Out of scope

- Push delivery. Step 09.
- Any UI.

## Reuse (search first)

- OpenAI Symphony's claim state machine (`Unclaimed → Claimed → Running → RetryQueued → Released`) as the reference shape.
- `~/.claude/hooks/ci-watch-arm.sh` for the "block Stop until CI green" pattern, if the implement phase needs it.

## Deliverables

- `src/master-agent.ts` (state machine), `src/phases/*.ts` (one file per phase, under the 500-line limit).
- `tests/master-agent.test.ts` with a fake runner, fake Linear, fake clock: happy path, stall → resume → resume → fresh → blocked, 2-hour expiry, rate-limit pause and resume, bounce path, REVIEW_EXHAUSTED.
- `docs/state_machine.md` — the state diagram and the event list.

## Acceptance criteria

- Happy path ends with the issue in Needs Verification, a hand-off posted, and a `finished` event.
- Every failure path ends in exactly one terminal state and one event.
- A restart of the orchestrator mid-Implementing continues from the `claims` row without starting a second job.
- No phase can run past the 2-hour clock.

## Open questions for grilling

1. One process per master agent, or one orchestrator process holding N state machines? One process is simpler and survives fine because the Claude daemon owns the jobs.
2. On rate-limit resume: wait for a fixed delay from config, or probe by relaunching and reading the error again?
3. Should the fresh restart after 2 resumes also reset the 2-hour clock, or keep the original deadline?
4. Where do follow-ups get filed: at the end of the issue (batch) or as soon as `followups.json` changes?
5. Does a bounce re-run the review loop before hand-off? The spec says yes (done gate), but it costs a cycle.
