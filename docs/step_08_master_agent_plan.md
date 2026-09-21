# Step 08 — Master Agent State Machine: implementation plan

<!-- Last edited: 2026-09-20 22:30 CDT -->

**TLDR:** We build the brain that drives one issue from start to finish.
It runs the four phases in order: plan, implement, review, hand-off.
It watches the clock, restarts stuck agents, pauses on rate limits, and rebases sister PRs when one merges.
All the parts exist from steps 03–07; this step connects them.

## Context

Steps 06 (hand-off package, PR #10) and 07 (queue + scheduler, PR #9) are merged to `main`.
Step 08 is the integration step: one `MasterAgent` per claim, plugged into the scheduler through `MasterAgentHooks` and `startLoop` (`src/scheduler/index.ts`).
The spec is `docs/steps/08_master_agent_state_machine.md` plus sections 5.1, 5.2, 6.6, 7, 10.2 of `docs/project_marshall_plan.md`.

## Decisions (grilling, 2026-09-20)

1. **`awaiting_human` frees its slot.**
   Migration 004 recreates `claims_live_slot` so parked states (`awaiting_human`, `rebasing`, `released`, `blocked`) do not hold a slot.
   The claim row and worktree stay for rebases and bounces.
   Reconcile becomes phase-aware: a parked or rate-limited claim is kept without a liveness check and without a resume bump.
2. **Rebases are serial; resolver runs are slot-only.**
   One stale PR per tick, oldest first.
   A deterministic `git rebase origin/main` + push runs inline (no slot).
   A resolver agent run needs a free concurrency slot (re-acquired via `lowestFreeSlot`) but does not spend the daily or window start caps — same rule as resumes (`firstStart: false`).
3. **Rate limit: parse, else probe.**
   Best-effort parse of "Resets at <time>" from `error_details` → `setPause(db, until)`.
   Parse failure → pause `rateLimitProbeMinutes` (new config key, default 30).
   On expiry, probe by resuming the rate-limited job; another rate-limit failure re-pauses without bumping `resumes`.
4. **The fresh restart keeps the original 2-hour deadline.**
   Guard: if fewer than 20 minutes remain, skip the fresh start and go straight to `Blocked`.
5. **Full done gate on every bounce.** No special-casing; the implement skill already enforces it.

Settled by code/doc, not asked: one orchestrator process holds N master agents (dictated by `startLoop` + `MasterAgentHooks`); follow-ups are filed in batch after the hand-off; the step file's Q1/Q4 are closed.

## Premise check against `origin/main` (2026-09-20)

Everything the plan names exists with the shape it assumes, except:

- `plugin/skills/review/` already exists (step 05). Nothing to copy.
- The scheduler's reconcile calls no hook for a claim whose agent is alive ("kept"), so a restarted orchestrator has no way to learn about it.
  Added: an optional `attach(claim)` hook, called by reconcile on every kept claim (alive or parked).
- `startLoop` only calls `tick`, and `tick` returns early while paused.
  Added: an optional `pulse()` hook that `startLoop` calls before every tick, paused or not, for the stall check, the clock, the merge poll, the rebase queue, and the rate-limit probe.
- `RunWaiter.wait` resolves only on a hook event or its timeout; killing a run does not wake it.
  Added: `RunWaiter.settle(runId, terminal)` so the pulse can end a phase's wait on a stall or the 2-hour clock.
- `Terminal` carries only the failure kind (`rate_limit`), not the hook's `error_details` that names the reset time.
  Added: `Terminal.details` from `classify()`, and the same field read back from the hook row for a run that ended before a restart.
- The merge poll needs each claim's PR URL without reading `implement.json` for every claim every tick.
  Added: claims columns `pr_url` and `rebase_after` (the merged PR that queued the rebase; it is also the badge text).
- There is no loop entrypoint in the CLI. Added `marshall run` (reconcile, then loop with the real hooks; Ctrl-C stops). launchd wiring stays step 09.

## Files

### New

- `src/master-agent.ts` — public surface: `createMasterAgentHooks(deps)`, the `MasterDeps` shape, and the default deps for the CLI.
- `src/master/types.ts` — phase states, event names, `MasterDeps`, injectable `RunnerOps`, `GitOps`, `PhaseRunners`.
- `src/master/agent.ts` — the `MasterAgent` class: the driver (`plan → implement → handoff → awaiting_human`), the 2-hour clock, the fresh restart, and the rate-limit wait.
- `src/master/orchestrator.ts` — the map of live agents; `start`, `resume`, `attach`, `pulse`.
- `src/master/store.ts` — claim column helpers (`plan_path`, `model`, `pr_url`, `fresh_restarts`, `rebase_after`) and the parked-state queries.
- `src/master/ratelimit.ts` — "Resets at" parser and the pause helper.
- `src/master/discard.ts` — reset the worktree to a commit, drop `implement.json`, delete the remote branch.
- `src/phases/plan.ts` — wraps `runPlanPhase`; fresh or revise; stores `model` and `planPath` on the claim.
- `src/phases/implement.ts` — `launch` of `/marshall:implement`, the wait loop with stall resumes, the rate-limit probe, and the outcome read from `implement.json`.
- `src/phases/handoff.ts` — wraps `runHandoffPhase`; then Needs Verification, batch follow-ups, `awaiting_human`, `finished`.
- `src/phases/rebase.ts` — merge poll, the serial rebase queue, inline rebase + push, CI poll, resolver launch, badge re-post.
- `src/db/migrations/004_master.sql` — recreate `claims_live_slot`; add the five columns.
- `plugin/skills/resolve-conflicts/` — from `~/.claude/skills/resolving-merge-conflicts/`, ending with the full done gate.
- `docs/state_machine.md` — state diagram + event list.
- `tests/master/*.test.ts`, `tests/phases/*.test.ts`, `tests/master/helpers.ts`.

### Modified

- `src/scheduler/types.ts`, `reconcile.ts`, `index.ts` — `attach` and `pulse` hooks; parked states; `startLoop` pulses.
- `src/plan/wait.ts`, `src/plan/types.ts` — `settle`.
- `src/runner/events.ts`, `types.ts` — `Terminal.details`.
- `src/config.ts` + `marshall.config.json` — `rateLimitProbeMinutes: 30`.
- `src/cli/index.ts` + `src/cli/run.ts` — `marshall run`.
- `tests/fixtures/fake-gh` — `pr view --json mergedAt,state` and `pr checks --json bucket`.

## Mechanics worth pinning

- **One watcher.** The orchestrator owns one `createRunWaiter` (`src/plan/wait.ts`) built over one `startWatcher`; every phase gets the same waiter.
- **State storage.** Phase states are written to `claims.state` (`planning`, `implementing`, `handoff`, `awaiting_human`, `rebasing`, `resolving`, `rate_limited`, ...); a restart rebuilds each `MasterAgent` from its row via reconcile → `hooks.attach` / `hooks.resume`.
- **Resolver slot re-acquisition.** Entering `resolving` re-holds a slot through the partial index; take `lowestFreeSlot` and update `claim.slot`; no free slot → wait for the next tick.
- **Stall path.** `runner.isStalled(db, runId, config.stallMinutes)` → kill + `runner.resume`, bump `claims.resumes`; after `maxResumes` (2): discard the branch, one fresh restart of the current phase (`fresh_restarts` = 1), respecting decision 4's 20-minute guard; failure after that → `Blocked`.
- **Over budget.** Clock check on every pulse and before every launch; expiry → kill, emit `over_budget`, mark `Blocked` (with Linear comment via `blockIssue`).
- **Events.** `insertEvent` (scheduler store) with: `phase_changed`, `finished`, `blocked`, `over_budget`, `stalled`, `resumed`, `fresh_restart`, `rate_limited`, `rate_limit_resumed`, `crashed`, `pr_merged`, `pr_closed`, `rebase_queued`, `rebased`, `rebase_conflict`.

## Tests (fake runner, fake Linear, fake clock, fake waiter, fake git, fake gh)

- Happy path → Needs Verification, hand-off posted, `finished` event, slot freed.
- Stall → resume → resume → fresh restart → blocked; and the <20-min guard.
- 2-hour expiry mid-implement.
- Rate-limit pause (parsed time and probe fallback) and resume.
- Bounce → plan revise mode → implement on same branch → hand-off rewrite.
- `review_exhausted` → Blocked.
- Sibling merge → clean rebase → badge re-post; conflict → resolver (slot-only, serial) → done gate → re-post.
- Orchestrator restart mid-implementing continues from the claims row without a second job.

## Workflow

1. Fast-forward local `main`; create a worktree (gitignored, `.env` copied, `bun install` for husky) on branch `feat/step-08-master-agent`.
2. Copy this plan to `docs/step_08_master_agent_plan.md`; update `docs/steps/08_master_agent_state_machine.md` with the grilling decisions.
3. Implement in small commits: migration + reconcile → waiter + runner → phases → master agent → rebase → plugin skill → CLI → docs.
4. Verify: `bun test`, lint via pre-commit; no live/launchd run (that is step 10).
5. Open a PR (no merge); kill any processes started during verification.
