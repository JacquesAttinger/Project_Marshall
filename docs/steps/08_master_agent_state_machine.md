# Step 08 — Master Agent State Machine

<!-- Last edited: 2026-09-20 10:56 CDT -->

**TLDR:** The brain for one issue.
It runs plan → implement → review → hand-off, watches the clock, restarts a stuck agent, and knows when to give up and call me.
This is the step that wires 03 through 07 together.

## Goal

One `MasterAgent` class per claim that drives the phases in order, enforces every limit in the spec, and emits events the notifier and dashboard read.

## Depends on / parallel with

- Depends on: 03, 04, 05, 06, 07.
- Parallel with: nothing. This is the integration step.

## Spec references

Sections 5.1, 5.2, 6.6, 7, 10.2 of `project_marshall_plan.md`.

## In scope

### States

`Claimed → Planning → Implementing → Reviewing → PR Open → Awaiting Human` and `Released`.
`PR Open → Rebasing → PR Open` when another Marshall PR merges.
Failure states: `Blocked`, `Stalled`, `Over Budget`, `Rate Limited`.

### Phases

- **Planning:** one call, `runPlanPhase({ db, linear, config, issue, cwd, mode, model?, waiter })` from `src/plan/index.ts` (step 04). It classifies, writes the brief, launches `/marshall:plan <brief>`, waits for the `Stop` hook, verifies with git that only the plan file changed, checks the headings, and posts the summary. Store `result.model` and `result.planPath` on the claim; a bounce reuses them.
- **Implementing + Reviewing:** `runner.launch` with `/marshall-implement <plan> <issue> <slot>`. Done when the `Stop` hook arrives and a PR URL exists. `REVIEW_EXHAUSTED` → `Blocked`.
- **Hand-off:** run the hand-off writer, `handoff.post()`, move the issue to Needs Verification, file `followups.json` via `linear.createFollowUp`, emit `finished`.
- **Bounce:** on pickup of an issue with an existing branch, run Planning again in revise mode (`mode: "revise"`, `model` from the claim, `revision` = bounce count). The planner updates the plan and appends `## Revision N`. Then Implementing resumes on the same branch with the revised plan. Rewrite the hand-off at the end.
- **Merge detection and Rebasing:** each tick, poll `gh pr view --json mergedAt` for every open Marshall PR. When one merges, every other open Marshall PR enters `Rebasing`: deterministic `git rebase origin/main` in its worktree, push, wait for CI. Clean and green → re-post the hand-off with a "rebased after <PR>" badge, back to `PR Open`. Conflict or red → launch a resolver run with `/marshall:resolve-conflicts` (the `resolving-merge-conflicts` skill copied into the plugin), then the full done gate (tests, lint, CI, `code-review`), then re-post the hand-off and push a notification. This replaces the overlap check that was dropped on 2026-09-20.

### Limits

- Issue clock: 2 hours from claim across all phases. On expiry: kill, emit `over_budget`, mark Blocked.
- Stall: `runner.isStalled(job, 5)` → `runner.resume`. Count resumes. After 2: discard the branch, restart the current phase fresh once. If that also fails: Blocked.
- Fix cycles: enforced inside `marshall-implement` (4). This step only reads the result.
- Rate limit: `runner.rateLimited(event)` → set the scheduler pause flag, keep the claim, emit `rate_limited`. On the next 5-hour boundary (or a config delay), resume the job and clear the flag, emit `rate_limit_resumed`.
- Crash of the orchestrator: state is in the `claims` row, so a restart plus step 07's reconcile can rebuild the object and continue.

### Events

`phase_changed`, `finished`, `blocked`, `over_budget`, `stalled`, `resumed`, `rate_limited`, `rate_limit_resumed`, `crashed`, `rebased`, `rebase_conflict`.
Written to the `events` table; step 09 maps them to pushes.

## Out of scope

- Push delivery. Step 09.
- Any UI.

## Reuse (search first)

- OpenAI Symphony's claim state machine (`Unclaimed → Claimed → Running → RetryQueued → Released`) as the reference shape.
- `~/.claude/hooks/ci-watch-arm.sh` for the "block Stop until CI green" pattern, if the implement phase needs it.
- `~/.claude/skills/resolving-merge-conflicts/` and `~/.claude/skills/code-review/` — copy into the `marshall` plugin as `skills/resolve-conflicts/` and `skills/review/` before this step; user skills do not load in agent sessions.
- `src/plan/wait.ts` `createRunWaiter` — the shape of a `RunWaiter`; this step owns one watcher and builds one waiter over it for every phase.

## Deliverables

- `src/master-agent.ts` (state machine), `src/phases/*.ts` (one file per phase, under the 500-line limit).
- `tests/master-agent.test.ts` with a fake runner, fake Linear, fake clock: happy path, stall → resume → resume → fresh → blocked, 2-hour expiry, rate-limit pause and resume, bounce path (Planning in revise mode first), REVIEW_EXHAUSTED, merge of a sibling PR → Rebasing clean, → Rebasing conflict → resolver → done gate.
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
6. Rebasing: rebase every other open Marshall PR at once, or one per tick to keep the caps honest? A resolver run counts as a start.
