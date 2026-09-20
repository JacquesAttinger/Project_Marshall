# Step 04 — Planning Phase

<!-- Last edited: 2026-09-19 21:05 CDT -->

**TLDR:** Two things: a cheap Haiku call that says "simple" or "complex," and a `jarvis-plan` skill that is `linear-plan` without the interview.
The skill reads the issue, explores the repo, writes a plan file, and posts a summary to Linear.

## Goal

Given an issue id and a worktree, produce `docs/<topic>_plan.md` with no human in the loop, using Opus or Fable based on the classifier.

## Depends on / parallel with

- Depends on: nothing for the skill. 01 for the classifier code.
- Parallel with: 02, 03, 05.

## Spec references

Sections 6.1, 6.2, 7.1, 11 of `project_jarvis_plan.md`.

## In scope

### Classifier `src/classify.ts`

- `classify(issue) → {complexity: "simple" | "complex", reason}`.
- Runs `claude -p --model haiku --output-format json --json-schema <schema>` (non-bare, so the Max login works).
- Input: title, description, priority, labels, comment count. No repo access.
- Mapping: `simple → opus`, `complex → fable`. The mapping lives in config.

### Skill `skills/jarvis-plan/SKILL.md`

- Fork of `~/.claude/skills/linear-plan/SKILL.md` with these changes:
  - Remove step 4 (`/grilling`). No questions to the human.
  - Keep the orientation walkthrough. Write it into the plan file as the first section; step 06 reuses it for the hand-off.
  - Add a **Likely touched files** section: paths or globs the fix will touch. Step 07's overlap check reads this.
  - Add a **Decisions made alone** section: every call the agent made that a human would normally be asked about.
  - Add an **Out of scope found** section: items to file as follow-ups (step 05 or 08 files them).
  - Plan file path: `docs/<topic>_plan.md` in the worktree, TLDR at the top, per the global plan policy.
  - End by posting a short summary comment to the Linear issue.
- The skill runs inside a worktree that the orchestrator already created (step 07), on the issue's branch.

## Out of scope

- Implementation. That is step 05.
- Creating the worktree.

## Reuse (search first)

- `~/.claude/skills/linear-plan/SKILL.md` — the base.
- `~/.claude/skills/triage/AGENT-BRIEF.md` — brief format for AFK agents; borrow its structure for the prompt preamble.
- `~/.claude/skills/brainstorming/` — the "surface ambiguities" checklist can run silently and feed "Decisions made alone."

## Deliverables

- `src/classify.ts` + `tests/classify.test.ts` (golden issues: one obviously simple, one obviously complex).
- `skills/jarvis-plan/SKILL.md` and a symlink or install note so Claude Code can find it.
- `docs/plan_template.md` — the section list the plan must contain.
- A recorded run: one real ChessBuddy issue planned end to end, with the plan file checked in under `docs/examples/`.

## Acceptance criteria

- `classify` returns valid JSON for 5 sample issues in under 10 seconds each.
- `claude --bg --name test-plan --model opus "/jarvis-plan CB-1"` in a worktree produces the plan file with all required sections and posts one Linear comment.
- The plan file passes a section-heading check script.
- No `AskUserQuestion` calls appear in the transcript.

## Open questions for grilling

1. Skills live in the repo under `skills/` and get symlinked into `~/.claude/skills/`, or get passed with `--add-dir` / a plugin dir at launch?
2. Should the classifier also estimate "likely touched files" from the issue text, so the overlap check can run before planning starts?
3. Does the planner get a token or turn budget separate from the 2-hour issue clock?
4. Fable for `complex` only, or Fable whenever priority is Urgent as well?
5. Should the plan be committed to the branch, or stay untracked in the worktree?
