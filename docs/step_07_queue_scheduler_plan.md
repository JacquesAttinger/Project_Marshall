# Step 07 — Queue and Scheduler: implementation plan

<!-- Last edited: 2026-09-20 -->

**TLDR:** This step builds Marshall's dispatcher.
Every 45 seconds it looks at Linear for issues you gave to yourself, picks the most urgent one, and checks three budget rules so it never uses more Claude time than your plan allows.
If the rules say yes, it claims the issue, makes a private copy of the ChessBuddy repo (a worktree), and hands the issue to a worker agent.
If Marshall crashes, this step also cleans up on restart so no issue stays stuck.

## Context

Steps 01–05 built the scaffold, the Linear client, the agent runner, and the plan/implement/review phases.
Step 07 wires the existing parts into the loop that decides *when* work starts.
The step spec is `docs/steps/07_queue_and_scheduler.md`.
It had five open questions; the grilling session on 2026-09-20 settled them (see Decisions).

## Decisions (from grilling, 2026-09-20)

1. **The scheduler creates the worktree.**
   `startMasterAgent(claim)` receives a ready workspace.
   Step 08 never runs git worktree commands.
2. **Reconcile resumes through a step-08 hook.**
   If `claims.resumes < maxResumes`, reconcile calls `hooks.resume(claim)` and increments `claims.resumes`.
   One counter serves boot resumes and in-run resumes.
   Until step 08 lands, the default hook releases the issue to Todo with a comment.
3. **Only first-time starts count against the caps.**
   A bounce restart and a reconcile resume do not insert a `starts` row.
   The concurrency cap still applies to every launch.
4. **The daily cap is a calendar day.**
   Count `starts` rows whose local date is today.
   The count resets at local midnight.
5. **The pause flag is `pause_until` in SQLite.**
   A key-value `flags` table holds an ISO timestamp.
   The scheduler polls but does not start while `now < pause_until`.
   Step 08 sets it on a rate limit; it clears itself by time.

## What already exists (reuse, do not rebuild)

- `src/linear/index.ts` — `listPickable()` (returns unsorted issues), `claim()`, `release()`, `setState()`, `getIssue()`.
- `src/runner/index.ts` — `status()`, `listDaemonSessions()`, `readJobState()`, `listActiveRuns()` for liveness.
- `src/db/` — migration runner; `claims`, `starts`, `events`, `runs` tables (001, 002). `claims` already has `bounces`, `resumes`, `slot` with a unique index on live slots.
- `src/config.ts` — all caps: `maxAgents`, `dailyStartCap`, `windowStartCap`, `windowHours`, `pollSeconds`, `maxBounces`, `maxResumes`.
- `src/isolation.ts` — `slotEnv(slot, config)` for per-slot ports.
- `src/git.ts` — `runGit`.
- `tests/linear/fake-linear.ts` — fake Linear client for scheduler tests.
- `~/.claude/skills/ship-plan/SKILL.md` step 2 — the worktree + `.env` copy commands to mirror.

## Files to create

### `src/db/migrations/003_flags.sql`

```sql
CREATE TABLE flags (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

`pause_until` lives here.

### `src/caps.ts`

Pure functions over the DB and an injected clock (`now: Date`), so tests use a fake clock.

- `liveClaims(db)` — claims with `state NOT IN ('released', 'blocked')`. Matches the existing `claims_live_slot` index.
- `startsToday(db, now)` — `starts` rows with `started_at` on today's *local* date.
- `startsInWindow(db, now, windowHours)` — rolling window.
- `capCheck(db, config, now, opts)` returns `{ ok: boolean, reasons: string[] }`.
  `opts.firstStart: boolean` — when false (bounce or resume), skip the daily and window checks (Decision 3).
  Reasons are human-readable strings; `marshall queue` prints them.
- `pauseUntil(db)` / `setPause(db, until)` — read/write the flag.

### `src/worktree.ts`

- `createWorktree({ repoPath, branch, baseBranch })`:
  `git fetch origin`, then `git worktree add <repoPath>/../ChessBuddy-<branch> -b <branch> origin/<baseBranch>`.
  Copy `.env` from the main checkout into the worktree (mirror ship-plan step 2).
- `reuseWorktree(...)` for bounces: if the worktree path exists, reuse it; if only the branch exists, add a worktree for it without `-b`.
- `removeWorktree(...)` for cleanup paths.
- Use `runGit` from `src/git.ts`.

### `src/scheduler.ts`

The loop, built for testability: `tick()` does one pass; `startLoop()` wraps it with `pollSeconds` and jitter-free `setTimeout`.

Dependencies are injected: `{ db, config, linear, runner, hooks, now }` where `hooks: MasterAgentHooks`.

```ts
interface MasterAgentHooks {
  start(claim: Claim): Promise<void>;   // step 08 implements
  resume(claim: Claim): Promise<void>;  // step 08 implements; default releases
}
```

Step 07 ships a default `hooks` whose `start` logs and whose `resume` releases (Decision 2 fallback).

**Tick order:**

1. If `now < pause_until`, log and return (poll continues, starts do not).
2. `listPickable()`, then sort: priority ascending with `0` (none) treated as lowest, then `createdAt` ascending.
3. For each issue, in order, while `capCheck` passes:
   a. **Bounce detection:** a `claims` row for this issue with a branch means a bounce.
      If `bounces >= maxBounces` (3): `linear.setState(issueId, 'Blocked')` + comment, set `claims.state = 'blocked'`, log event, continue.
      Otherwise increment `bounces` and plan to reuse the branch.
   b. **Write-ahead claim row:** insert/update the `claims` row with `state = 'claiming'` *before* touching Linear.
      A crash after Linear claim but before local recording would otherwise strand the issue (In Progress but invisible to `listPickable`).
      With the write-ahead row, reconcile can see and repair it.
   c. `linear.claim(issueId, agentId)`; on `false`, delete/release the write-ahead row and skip.
   d. Assign the lowest free slot (query live claims' slots).
   e. `createWorktree` (or reuse on bounce).
   f. Update the claim row (`state = 'claimed'`, branch, worktree_path, slot); insert a `starts` row **only when this is a first-time start** (Decision 3).
   g. `hooks.start(claim)`.
4. Every action writes an `events` row.

**Reconcile (runs once, before the first tick):**

For each `claims` row with `state NOT IN ('released', 'blocked')`:

- `state = 'claiming'` (write-ahead orphan): `linear.release(issueId, { comment })`, mark the row released, log.
- Ask the runner whether the claim's job is alive (match the active run by `cwd == worktree_path` via `listActiveRuns` + `status`).
- Alive: log and keep. Step 08 re-attaches its watcher later.
- Dead and `resumes < maxResumes`: increment `resumes`, call `hooks.resume(claim)` (Decision 2).
- Dead and out of resumes: `linear.release(issueId, { comment })`, mark released, log.

### `src/cli/queue.ts` (+ register in `src/cli/index.ts`)

`marshall queue` — a dry run of one tick.
Print the ordered pickable list and, for each issue: bounce or fresh, and the exact `capCheck` reasons why it can or cannot start now.
Print the pause state when set.
No writes.

## Tests

- `tests/caps.test.ts` — fake clock: concurrency cap, daily rollover at local midnight, true rolling 5-hour window, `firstStart: false` skips daily/window, pause read/write.
- `tests/scheduler.test.ts` — fake Linear (`tests/linear/fake-linear.ts`), fake runner, recording hooks:
  - ordering: Urgent first, then oldest; priority 0 sorts last;
  - 10 pickable, caps 2/6/2 → exactly 2 starts on the first tick (acceptance criterion);
  - skip on `claim()` returning false, write-ahead row cleaned up;
  - bounce increments `bounces`, reuses branch, inserts no `starts` row, blocks at `maxBounces`;
  - pause flag stops starts but not polling;
  - reconcile: releases a dead out-of-resumes claim, resumes a dead claim with budget, repairs a `claiming` orphan, keeps an alive claim.
- `tests/worktree.test.ts` — against a scratch git repo: create, `.env` copy, reuse on bounce, remove.

## Out of scope (unchanged from the step doc)

- Everything inside the master agent (step 08).
- Overlap checks (decided out 2026-09-20).
- Notifications and launchd (step 09) — log events instead.

## Open items past the question cap (recommendations, not asked)

1. **When does a claim free its slot?**
   The schema holds a slot until `released`/`blocked`, so an issue awaiting your PR review blocks one of the 2 slots.
   Recommendation: keep that behavior in step 07; decide the freeing point in the step 08 grilling (the worktree is still needed for post-merge rebases).
2. **Reconcile finds an alive job:** step 07 logs and keeps it; step 08 owns re-attachment.

## Workflow

1. Create a worktree `feat/step-07-queue-scheduler` off freshly pulled `origin/main` (add to `.gitignore`, copy `.env`, run `bun install` so husky hooks work).
2. Copy this plan to `docs/step_07_queue_scheduler_plan.md` as the first commit.
3. Update `docs/steps/07_queue_and_scheduler.md`: resolve open questions 1, 3, 4, 5 with the decisions above.
4. Implement in the order: migration → caps → worktree → scheduler → CLI, tests alongside each.
5. Run `bun test`, lint, and the size check once at the end.
6. Verify `bin/marshall queue` against the real ChessBuddy Linear team (read-only).
7. Open a PR; do not merge.

## Verification

- `bun test` green, including the three acceptance-criteria tests (first-tick starts exactly 2; midnight rollover; kill-and-restart reconcile leaves Linear consistent — simulated in tests with the fake runner).
- `bin/marshall queue` output matches what a tick would do next (compare by running it against a seeded local DB).
- Kill every process opened during verification before reporting done.
