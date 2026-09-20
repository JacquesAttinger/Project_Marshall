# Plan — Record the step 06 grilling decisions

<!-- Last edited: 2026-09-20 14:40 CDT -->

**TLDR:** We asked five questions about the hand-off package and you answered all five.
Now we write those answers into the step 06 document, so the builder does not have to guess.
This change touches only documentation.

## Context

The grilling-fast session on `docs/steps/06_handoff_package.md` closed all five open questions.
The step doc still lists them as open, and parts of "In scope" hedge between the options.
This plan bakes the decisions into the doc on a fresh branch and opens a PR.

## Decisions (from the interview, 2026-09-20)

1. **Writer home:** a separate skill, `skills/marshall-handoff/SKILL.md`.
   The step 08 bounce path (`docs/steps/08_master_agent_state_machine.md:34`) rewrites the hand-off without re-running implementation.
2. **Linear comment:** the full six-section package.
   The acceptance criterion "both containing the same text" stays as written.
3. **Bounce shape:** full rewrite, plus a short "Round N — what changed" block right after the TLDR.
   `validate()` permits this block as an optional extra heading, never as a seventh required one.
4. **PR body:** `post()` manages a `## Hand-off` section between HTML comment markers (`<!-- marshall-handoff:start -->` / `<!-- marshall-handoff:end -->`).
   First post appends the section; a repost replaces only the text between the markers.
   `Closes <URL>` and human edits to the rest of the body survive, and repost is idempotent.
5. **Section 5 file list:** only the files that matter, one line each with what changed and why.
   Generated files collapse to one summary line.
   The PR URL in section 6 carries the exhaustive diff.

## Changes

One file: `docs/steps/06_handoff_package.md`.

- Replace the "Open questions for grilling" section with "Decisions — grilled 2026-09-20" holding the five answers above.
- In "In scope → Writer": drop "or a final section of `marshall-implement`"; the writer is the separate skill.
- In "In scope → Poster": state the marker-delimited PR-body behavior and that `validate()` allows the optional Round-N heading.
- In "In scope → Format": note the optional "Round N — what changed" block after the TLDR on bounces, and the "files that matter" rule for section 5.
- In "Acceptance criteria": add that a second `post()` on the same PR leaves exactly one Hand-off section, and that `validate` accepts a file with the optional Round-N block.
- Update the "Last edited" comment at the top of the file.

No code changes. No changes to the spec (`project_marshall_plan.md` section 7.1 already matches decision 2) or to step 08 (already says "rewrite").

## Workflow

- `git fetch` and fast-forward `main`, then branch `docs/step-06-handoff-decisions` from the `main` tip.
- Commit, open a PR with a concise description. Do not merge.
- After plan approval, copy this plan to `docs/step_06_handoff_decisions_plan.md` before editing.

## Verification

- Re-read the edited doc: no remaining "open question" language, the six-section format is unchanged, and the five decisions each appear once.
- Docs-only change, so no tests or lint beyond the pre-commit hook.
