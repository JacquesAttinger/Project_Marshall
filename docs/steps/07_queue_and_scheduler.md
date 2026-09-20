# Step 07 — Queue and Scheduler

<!-- Last edited: 2026-09-20 10:56 CDT -->

**TLDR:** The part that looks at Linear every minute, decides which issue is next, checks that the caps allow a start, claims it, creates its worktree, and hands it to a master agent.
It also cleans up after a crash.

## Goal

A loop that never starts more than the caps allow and never leaves an issue claimed with no agent behind it.
There is no overlap check in iteration 1: two agents may touch the same code, and conflicts are resolved after a merge (step 08, Rebasing).

## Depends on / parallel with

- Depends on: 01, 02.
- Parallel with: 06.
- Hands off to: 08 via an interface `startMasterAgent(claim)`.

## Spec references

Sections 5.3, 5.4, 6.6 (reconcile), 10.2 (caps and cadence) of `project_marshall_plan.md`.

## In scope

- Poll loop: every `pollSeconds` (30–60), call `listPickable()` (state type `unstarted`, assignee me, ChessBuddy team). Issues already carrying a `marshall/agent-*` label are skipped by `claim()`.
- Ordering: Linear priority (Urgent first), then oldest created.
- Caps, all read from config and the `starts` table:
  - concurrency: active claims < `maxAgents` (2);
  - daily: starts today (local time) < `dailyStartCap` (6);
  - window: starts in the last `windowHours` (5) < `windowStartCap` (2).
- Pause flag: a row or file set by step 08 on rate limit. When set, poll but do not start.
- Bounce detection: if the issue already has a `claims` row with a branch, this is a bounce. Increment `bounces`; if over `maxBounces`, mark Blocked instead of starting.
- Claim: `linear.claim()`; on false, skip.
- Worktree: `git worktree add ../ChessBuddy-<branch> -b <gitBranchName> origin/main` (or reuse on bounce), copy `.env` as `ship-plan` does. Assign the lowest free slot (0 or 1).
- Insert the `claims` row and a `starts` row. Call `startMasterAgent`.
- Reconcile on boot: for each `claims` row not in a terminal state, ask the runner (step 03) if the job is alive. If not, release: call `linear.release(issueId, { comment })` (state → Todo, agent label removed), or hand to step 08's resume logic. Log each decision.

## Out of scope

- What happens inside an agent. That is step 08.
- Any overlap check. Decided out on 2026-09-20 (step 04 grilling): conflicts are handled after a merge by step 08's Rebasing phase.

## Reuse (search first)

- `~/.claude/hooks/session-start-linear-suggest.sh` — priority-sorted query.
- `~/.claude/skills/ship-plan/SKILL.md` step 2 — worktree and `.env` copy commands.
- `~/claude-tools/branch-janitor/janitor.sh` — worktree cleanup for later.

## Deliverables

- `src/scheduler.ts`, `src/caps.ts`, `src/worktree.ts` (`runGit` already lives in `src/git.ts`).
- `tests/caps.test.ts` with a fake clock: concurrency, daily rollover at midnight local, rolling 5-hour window.
- `tests/scheduler.test.ts` with a fake Linear client and fake runner: ordering, skip on claim failure, bounce counting, pause flag, reconcile releases a dead claim.
- `bin/marshall queue` — prints the ordered pickable list and, for each, why it can or cannot start now.

## Acceptance criteria

- With 10 pickable issues and caps at 2/6/2, exactly 2 start on the first tick and no third starts until one finishes or the window allows.
- Daily count resets at local midnight; the window count uses a true rolling 5 hours.
- Killing the orchestrator mid-run and restarting it releases the dead claim and leaves Linear consistent.
- `marshall queue` output matches what the loop would do next.

## Open questions for grilling

1. Daily cap on a calendar day, or on a rolling 24 hours?
2. ~~When the overlap check is unsure, allow or wait?~~ Moot: no overlap check in iteration 1 (see step 08, Rebasing).
3. On reconcile, resume the dead agent (step 08) or release to Todo? The spec says resume up to 2 times; decide who owns that counter.
4. Should the scheduler create the worktree, or should step 08 do it as the first phase? Scheduler is simpler for reconcile; step 08 keeps all per-issue work in one place.
5. Should a bounce count against the daily and window caps? It is a new start in terms of Max usage.
