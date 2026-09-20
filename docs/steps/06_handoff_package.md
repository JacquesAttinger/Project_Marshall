# Step 06 — Hand-off Package

<!-- Last edited: 2026-09-20 17:35 CDT -->

**TLDR:** The note the robot leaves on my desk.
It tells me where the feature is, what was wrong, what the robot did, and how to check it.
It goes to Linear, the PR, and a file the dashboard reads.

## Goal

A fixed six-section document produced at the end of every issue, so I can decide "merge as-is" or "test by hand" without reading the diff cold.

## Depends on / parallel with

- Depends on: 02 (Linear comment), and `gh` for the PR body.
- Parallel with: 07.
- Consumes: the plan file from 04 (orientation section), the PR from 05.

## Spec references

Sections 7.1, 8.3 of `project_marshall_plan.md`.
Format source: `~/.claude/skills/linear-plan/SKILL.md`, step 3 (the orientation walkthrough).

## In scope

### Format `docs/handoff_template.md`

1. **TLDR** — one or two lines.
2. **Where to find it** — click-by-click UI path, or "not UI-reachable" for backend work.
3. **Orientation** — app area → specific part → exact section, each with what it does.
4. **What was wrong and why.**
5. **What the agent did** — the fix, the files that matter (one line each: what changed and why; generated files collapse to one summary line), decisions made alone (from the plan's section). The PR URL in section 6 carries the exhaustive diff.
6. **Verification recipe** — branch, PR URL, setup or seed steps, steps to run, expected result.

On a bounce the writer rewrites the whole package and adds an optional block, **Round N — what changed**, right after the TLDR.
`validate()` accepts this heading as an extra; it is never a seventh required section.

### Writer

- A separate skill, `plugin/skills/handoff/SKILL.md`, invoked as `/marshall:handoff <plan-path> <ISSUE-ID>`. It reads the plan, the diff, and the PR, and writes `~/.marshall/handoffs/<ISSUE-ID>.md`. Separate, so the step 08 bounce path can rewrite the hand-off without re-running implementation.
- No screenshots or logs. Tests and review already ran.

### Poster `src/handoff/`

- `postHandoff({ issue, linear, prUrl, cwd, round, badge? })`: Linear comment (step 02) with the full six-section package, `gh pr edit --body-file` to manage a `## Hand-off` section in the PR body, and a sidecar `~/.marshall/handoffs/<ISSUE-ID>.json` that records the comment id, round, PR URL, and badge.
- The PR-body section sits between HTML comment markers, `<!-- marshall-handoff:start -->` and `<!-- marshall-handoff:end -->`. The first `post()` appends the section; a repost replaces only the text between the markers. `Closes <URL>` and human edits to the rest of the body survive, and repost is idempotent.
- `checkHandoffFile(path, expected?)` checks all six headings exist in order, section 5 has its two bold sub-lists, and section 6 has a PR URL and a branch (matching `implement.json` when `expected` is given). It permits the optional "Round N — what changed" heading after the TLDR. `bin/marshall handoff check <file>` runs it.
- `runHandoffPhase(...)` owns the whole phase (launch the writer, wait, prove the worktree stayed clean, validate, resume once, post); step 08 makes one call. See [`../handoff.md`](../handoff.md).

## Out of scope

- Deciding when to post. Step 08 calls `post` on the transition to Needs Verification.
- The dashboard rendering. Iteration 2.

## Reuse (search first)

- `linear-plan` step 3 for the orientation wording.
- `~/.claude/skills/verify/SKILL.md` for the shape of a verification recipe.
- `hemut-ai-harness/skills/shared/ship/` — its PASS/FAIL evidence table is a good model for the recipe's "expected result" lines.

## Deliverables

- `docs/handoff_template.md` (human-facing) and `plugin/skills/handoff/template.md` (what the agent copies).
- `plugin/skills/handoff/SKILL.md`.
- `src/handoff/` (`validate`, `render`, `splice`, `meta`, `pr`, `post`, `phase`) + `tests/handoff/` (validate on a good file, a file missing a section, a file with no PR URL, and the rest of the matrix in `docs/step_06_handoff_package_plan.md`).
- One real hand-off checked in under `docs/examples/step06_CHE-5/` from the step 05 run.

## Acceptance criteria

- `validate` rejects a file missing any of the six headings.
- `post` results in one Linear comment and a PR body section, both containing the same text.
- A second `post` on the same PR leaves exactly one `## Hand-off` section, and the body text outside the markers is byte-identical to before.
- `validate` accepts a file that has the optional "Round N — what changed" block after the TLDR.
- The example hand-off lets a reader who has never opened ChessBuddy find the feature in the app from section 2 alone.

## Decisions (grilled 2026-09-20)

Full plan: [`../step_06_handoff_decisions_plan.md`](../step_06_handoff_decisions_plan.md).

| # | Question | Decision |
|---|---|---|
| 1 | Writer home | **Separate skill**, `plugin/skills/handoff/SKILL.md` (`/marshall:handoff`). The step 08 bounce path (`08_master_agent_state_machine.md`, Bounce phase) rewrites the hand-off without re-running implementation. |
| 2 | Linear comment | **Full six-section package.** The acceptance criterion "both containing the same text" stays as written. Matches spec section 7.1. |
| 3 | Bounce shape | **Full rewrite**, plus a short "Round N — what changed" block right after the TLDR. `validate()` permits this block as an optional extra heading, never as a seventh required one. |
| 4 | PR body | **Marker-delimited section.** `post()` manages a `## Hand-off` section between `<!-- marshall-handoff:start -->` and `<!-- marshall-handoff:end -->`. First post appends; a repost replaces only the text between the markers. `Closes <URL>` and human edits survive, and repost is idempotent. |
| 5 | Section 5 file list | **Only the files that matter**, one line each with what changed and why. Generated files collapse to one summary line. The PR URL in section 6 carries the exhaustive diff. |

## Implementation decisions (grilled 2026-09-20, second pass)

Full plan: [`../step_06_handoff_package_plan.md`](../step_06_handoff_package_plan.md). Built as `src/handoff/`; see [`../handoff.md`](../handoff.md).

| # | Question | Decision |
|---|---|---|
| 1 | Module scope | Step 06 owns the full phase. `runHandoffPhase(...)` in `src/handoff/` mirrors `runPlanPhase`: launch `/marshall:handoff`, wait for Stop, check the worktree stayed clean, validate, post. Step 08 makes one call. CLI `marshall handoff check <file>`. |
| 2 | Linear re-post | Edit the comment in place. A sidecar `~/.marshall/handoffs/<ISSUE-ID>.json` stores the comment id, round, PR URL, badge. New `UpdateComment` mutation. No `claims` migration; the hand-off path is deterministic. |
| 3 | Writer scope | Read-only. It reads the plan, the diff, the code, and `gh pr view`. It never starts the app. Target under 10 minutes (`handoffMinutes`). |
| 4 | Invalid file | Resume the same session once with the validation errors. Still invalid → `{ ok: false, reason: "handoff_invalid" }`. |
| 5 | Review notes and follow-ups | Inside section 5 as two bold sub-lists: **Review notes (not fixed)** and **Follow-ups proposed** (titles only, from `implement.json`). |
