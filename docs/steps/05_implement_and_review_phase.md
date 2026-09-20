# Step 05 — Implement and Review Phase

<!-- Last edited: 2026-09-20 10:30 CDT -->

**TLDR:** A `/marshall:implement` skill that runs `ship-plan` inside an existing worktree, keeps each agent's Docker services separate, then runs `/marshall:review` and fixes what it finds, up to 4 times.

> **Decided 2026-09-20.** The open questions below are closed; the answers and the final layout are in [`../step_05_implement_review_plan.md`](../step_05_implement_review_plan.md).
> Short form: the skills ship as a plugin at `plugin/` (`/marshall:implement`, `/marshall:review`), the skill reports through one JSON file at `$MARSHALL_HOME/issues/<ISSUE-ID>/implement.json` (no `followups.json`, no one-word status file), only `CONFIRMED` findings and spec gaps block, Compose isolation is env-only (`COMPOSE_PROJECT_NAME` plus per-port vars from `src/isolation.ts`), and a red run still ends with a draft PR.

## Goal

Given a plan file in a worktree, end with a green PR that a second Claude pass has approved, without touching another agent's ports or database.

## Depends on / parallel with

- Depends on: nothing for the skill. It is prompt and shell work.
- Parallel with: 02, 03, 04.
- Step 06 appends the hand-off to the PR body after this step finishes.

## Spec references

Sections 6.3, 6.4, 11, 12 of `project_marshall_plan.md`.

## In scope

### Skill `skills/marshall-implement/SKILL.md`

- Input: plan path, issue id, slot number (0 or 1).
- Adapt `ship-plan`:
  - Do **not** cut a new worktree. Use the current one (created in step 07).
  - Base branch `origin/main` for ChessBuddy.
  - Keep the `.env` copy step as-is (real credentials, per the spec).
  - Export `COMPOSE_PROJECT_NAME=marshall-<slot>` and `MARSHALL_PORT_OFFSET=<slot * 100>` before any `docker compose` or test command.
  - Implement with tests, small commits, run the full suite and lint, rebase, open the PR with the Linear identifier in the title and `Closes <issue URL>` in the body, poll CI.
- Review loop: run `/code-review` against the merge-base. Fix confirmed findings. Re-run tests and lint. Repeat up to **4** cycles. Then stop and write `REVIEW_EXHAUSTED` to a status file so step 08 can mark Blocked.
- Out-of-scope items found during implementation go to a `followups.json` file in the worktree; the orchestrator files them via step 02.

### ChessBuddy repo changes

- Make `docker-compose.yml` ports read `${MARSHALL_PORT_OFFSET:-0}` so two Compose projects can run side by side. Keep defaults so a normal `docker compose up` is unchanged.
- Confirm the test suite and app read their DB URL and ports from env, not hardcoded values.

## Out of scope

- The hand-off package. That is step 06.
- Deciding when to run this. That is step 08.

## Reuse (search first)

- `~/.claude/skills/ship-plan/SKILL.md` — the base. It already does worktree, `.env`, tests, lint, rebase, PR, CI poll.
- `~/.claude/skills/code-review/` — the reviewer.
- `~/.claude/hooks/ci-watch-arm.sh` — CI-green gate pattern.
- `hemut-ai-harness/policy/git-workflow/SNIPPET.md` — branch naming via Linear `gitBranchName`, PR title and body rules.

## Deliverables

- `skills/marshall-implement/SKILL.md`.
- A PR to ChessBuddy that makes Compose ports offset-aware.
- `docs/isolation.md` — how slot → project name → ports map, and how to clean up (`docker compose -p marshall-0 down -v`).
- A recorded run: one real ChessBuddy issue implemented end to end from a plan, PR link in `docs/examples/`.

## Acceptance criteria

- Two worktrees, slots 0 and 1, each run `docker compose up` and the test suite at the same time without port or DB collisions.
- The skill opens a PR with the Linear id in the title and CI goes green.
- The review loop runs at least once and records the cycle count.
- After 4 failed cycles the status file says `REVIEW_EXHAUSTED` and the skill stops.
- `followups.json` is written when the plan's "Out of scope found" section is non-empty.

## Open questions for grilling (closed 2026-09-20)

1. Modify `ship-plan` to accept "use the current worktree," or fork it into `marshall-implement` and let the two drift?
2. Port offset of 100 per slot: does ChessBuddy expose any port that would collide at +100?
3. Should the review pass block on `PLAUSIBLE` findings or only `CONFIRMED` ones?
4. Should tests run inside Compose or against a host-side DB with a per-slot database name?
5. Who commits the plan file: this skill, or step 04?

Answers: (1) fork into the plugin skill, `ship-plan` is the source, the two may drift; (2) no, ChessBuddy publishes 5432, 9324, 8000 only; (3) `CONFIRMED` only, `PLAUSIBLE` goes to `reviewNotes`; (4) tests need no services today, Compose comes up only when the plan asks; (5) step 04 commits it as the first commit on the branch, this skill never edits it.
