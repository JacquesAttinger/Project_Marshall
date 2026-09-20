# Step 06 — Hand-off Package

<!-- Last edited: 2026-09-19 21:15 CDT -->

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
5. **What the agent did** — the fix, files touched, decisions made alone (from the plan's section).
6. **Verification recipe** — branch, PR URL, setup or seed steps, steps to run, expected result.

### Writer

- A skill `skills/marshall-handoff/SKILL.md`, or a final section of `marshall-implement`. It reads the plan, the diff, and the PR, and writes `~/.marshall/handoffs/<ISSUE-ID>.md`.
- No screenshots or logs. Tests and review already ran.

### Poster `src/handoff.ts`

- `post(issueId, path)`: Linear comment (step 02), `gh pr edit --body-file` to replace or append a `## Hand-off` section, and record the path in the `claims` row.
- A `validate(path)` that checks all six headings exist and section 6 has a PR URL and a branch.

## Out of scope

- Deciding when to post. Step 08 calls `post` on the transition to Needs Verification.
- The dashboard rendering. Iteration 2.

## Reuse (search first)

- `linear-plan` step 3 for the orientation wording.
- `~/.claude/skills/verify/SKILL.md` for the shape of a verification recipe.
- `hemut-ai-harness/skills/shared/ship/` — its PASS/FAIL evidence table is a good model for the recipe's "expected result" lines.

## Deliverables

- `docs/handoff_template.md`.
- `skills/marshall-handoff/SKILL.md` (or the section in `marshall-implement`).
- `src/handoff.ts` + `tests/handoff.test.ts` (validate on a good file, a file missing a section, a file with no PR URL).
- One real hand-off checked in under `docs/examples/` from the step 05 run.

## Acceptance criteria

- `validate` rejects a file missing any of the six headings.
- `post` results in one Linear comment and a PR body section, both containing the same text.
- The example hand-off lets a reader who has never opened ChessBuddy find the feature in the app from section 2 alone.

## Open questions for grilling

1. Separate `marshall-handoff` skill, or the last step of `marshall-implement`? Separate is cleaner for bounces (rewrite the hand-off after a fix without re-running implementation).
2. Replace the PR body or append a section? `Closes <URL>` must survive.
3. Should section 5 list every file touched, or only the ones that matter, with a link to the diff?
4. On a bounce (issue comes back with a comment), does the hand-off get a "Round 2: what changed" section on top, or a full rewrite?
5. Should the Linear comment be the full package or a TLDR plus a link to the PR body, to keep Linear readable?
