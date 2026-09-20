# Step 10 — End-to-End Dry Run

<!-- Last edited: 2026-09-20 12:23 CDT -->

**TLDR:** Turn it on for real, on ChessBuddy, for a day or two.
Feed it real issues, break it on purpose, watch the pushes, read the hand-offs, then tune the caps and write down what "proven" means before Hemut.

## Goal

Evidence that the full loop works unattended, and a written bar for the Hemut rollout gate.

## Depends on / parallel with

- Depends on: everything, 01 through 09.
- Parallel with: nothing.

## Spec references

Sections 13 (Hemut rollout gate), 14, 15 "Still open" of `project_marshall_plan.md`.

## In scope

### Seed

- Pick 4 to 6 real, small ChessBuddy issues, or write them: at least one UI-reachable, one backend-only, one that obviously overlaps another, one with an out-of-scope trap in the description.
- Set them to Todo and assigned to me. No labels.

### Run

- Start Marshall via launchd. Do not touch the terminal for the first two issues.
- Confirm: 2 start, the third waits. The two that touch the same file both run; after the first one merges, the second is rebased (step 08, Rebasing) and its hand-off is re-posted.
- Read every hand-off cold. Score each: could I decide "merge as-is" vs "test by hand" from the package alone?
- Merge at least one as-is. Bounce at least one with a comment and confirm the plan gains a `## Revision 1` and the agent resumes the branch.

### Break

- Kill an agent from `marshall kill` mid-implement. Confirm `blocked` push and a clean claim.
- Sleep the laptop for 10 minutes during a run. Confirm stall → resume.
- Restart the orchestrator mid-run. Confirm reconcile continues, not duplicates.
- Force a rate-limit error if possible (or replay a payload). Confirm pause, one push, resume.

### Measure

- Tokens and wall clock per issue, from the `events` table and job state.
- How far the daily and window caps were from Max's real limits. Adjust 6 and 2 if needed.
- Hand-off quality score per issue.
- Count of follow-up issues filed, and whether any were noise.

## Out of scope

- Fixing anything big. File follow-ups in the ChessBuddy workspace and let Marshall pick them up.

## Deliverables

- `docs/dry_run_<date>.md` — what was seeded, what happened, the metrics above, and every bug found with its follow-up issue id.
- Config changes to caps, committed.
- `docs/hemut_gate.md` — the written bar. Proposed: N consecutive issues landed with at most one bounce each, zero orphaned claims across two restarts, hand-off score at or above a threshold, and the accepted risks from spec section 14 re-reviewed.

## Acceptance criteria

- All four "break" cases behave as the spec says.
- At least two issues merged, one bounced and re-landed, one blocked on purpose.
- Every push event was received on the phone.
- The dry-run doc exists and the Hemut gate doc exists.

## Open questions for grilling

1. How many consecutive clean issues count as "proven"? 5? 10?
2. Should the dry run include one deliberately bad issue (vague, no acceptance criteria) to see how the planner copes with no interview?
3. Do you want to raise the cap to 3 during the dry run, or only after it?
4. Is one weekday enough, or should it run over a weekend to test the daily cap rollover and window math across sleep?
5. What is the hand-off quality threshold, and who scores it — you, or a second Claude pass with a rubric?
