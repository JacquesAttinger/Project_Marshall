# Step 05 — Implement and Review Phase

<!-- Last edited: 2026-09-19 21:05 CDT -->

**TLDR:** A `jarvis-implement` skill that runs `ship-plan` inside an existing worktree, keeps each agent's Docker services separate, then runs `code-review` and fixes what it finds, up to 4 times.

## Goal

Given a plan file in a worktree, end with a green PR that a second Claude pass has approved, without touching another agent's ports or database.

## Depends on / parallel with

- Depends on: nothing for the skill. It is prompt and shell work.
- Parallel with: 02, 03, 04.
- Step 06 appends the hand-off to the PR body after this step finishes.

## Spec references

Sections 6.3, 6.4, 11, 12 of `project_jarvis_plan.md`.

## In scope

### Skill `skills/jarvis-implement/SKILL.md`

- Input: plan path, issue id, slot number (0 or 1).
- Adapt `ship-plan`:
  - Do **not** cut a new worktree. Use the current one (created in step 07).
  - Base branch `origin/main` for ChessBuddy.
  - Keep the `.env` copy step as-is (real credentials, per the spec).
  - Export `COMPOSE_PROJECT_NAME=jarvis-<slot>` and `JARVIS_PORT_OFFSET=<slot * 100>` before any `docker compose` or test command.
  - Implement with tests, small commits, run the full suite and lint, rebase, open the PR with the Linear identifier in the title and `Closes <issue URL>` in the body, poll CI.
- Review loop: run `/code-review` against the merge-base. Fix confirmed findings. Re-run tests and lint. Repeat up to **4** cycles. Then stop and write `REVIEW_EXHAUSTED` to a status file so step 08 can mark Blocked.
- Out-of-scope items found during implementation go to a `followups.json` file in the worktree; the orchestrator files them via step 02.

### ChessBuddy repo changes

- Make `docker-compose.yml` ports read `${JARVIS_PORT_OFFSET:-0}` so two Compose projects can run side by side. Keep defaults so a normal `docker compose up` is unchanged.
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

- `skills/jarvis-implement/SKILL.md`.
- A PR to ChessBuddy that makes Compose ports offset-aware.
- `docs/isolation.md` — how slot → project name → ports map, and how to clean up (`docker compose -p jarvis-0 down -v`).
- A recorded run: one real ChessBuddy issue implemented end to end from a plan, PR link in `docs/examples/`.

## Acceptance criteria

- Two worktrees, slots 0 and 1, each run `docker compose up` and the test suite at the same time without port or DB collisions.
- The skill opens a PR with the Linear id in the title and CI goes green.
- The review loop runs at least once and records the cycle count.
- After 4 failed cycles the status file says `REVIEW_EXHAUSTED` and the skill stops.
- `followups.json` is written when the plan's "Out of scope found" section is non-empty.

## Open questions for grilling

1. Modify `ship-plan` to accept "use the current worktree," or fork it into `jarvis-implement` and let the two drift?
2. Port offset of 100 per slot: does ChessBuddy expose any port that would collide at +100?
3. Should the review pass block on `PLAUSIBLE` findings or only `CONFIRMED` ones?
4. Should tests run inside Compose or against a host-side DB with a per-slot database name?
5. Who commits the plan file: this skill, or step 04?
