# Step 04 — Planning Phase

<!-- Last edited: 2026-09-20 10:56 CDT -->

**TLDR:** Two things: a cheap Haiku call that says "simple" or "complex," and a `/marshall:plan` skill that is `linear-plan` without the interview.
The orchestrator writes a brief file from the Linear issue, the skill reads it, explores the repo, writes and commits a plan file, and the orchestrator checks the result with git and posts a summary to Linear.
The agent never touches Linear.

Status: **built** on 2026-09-20. Implementation plan: [`../step_04_planning_phase_plan.md`](../step_04_planning_phase_plan.md). How it works: [`../planning.md`](../planning.md).

## Goal

Given an issue and a worktree, produce a committed `docs/<topic>_plan.md` with no human in the loop, using Opus or Fable based on the classifier.

## Depends on / parallel with

- Depends on: 01 (config), 02 (`LinearClient.getIssue`, `comment`), 03 (`launch`, the watcher).
- Parallel with: 05.

## Spec references

Sections 5.3, 5.4, 6.1, 6.2, 7.1, 11, 12, 14 of `project_marshall_plan.md`.

## Decisions (grilling of 2026-09-20)

| # | Question | Decision |
|---|---|---|
| 1 | Who talks to Linear during planning | **Orchestrator only.** It fetches the issue, writes a brief file, and passes the path to the skill. After the run it posts the TLDR and "Decisions made alone" as one comment. The runner adds `--strict-mcp-config` so the claude.ai Linear connector never reaches an agent. |
| 2 | Overlap check | **Dropped.** Two agents may touch the same code. Conflicts are resolved after a merge (step 08, Rebasing). The classifier stays complexity-only with no repo access. |
| 3 | Plan location | **Committed on the issue branch** as `docs/<topic>_plan.md`, one commit `Plan: <issue title>`. |
| 4 | Write boundary | **bypassPermissions + post-check.** Plan mode cannot be used. The orchestrator verifies with git that nothing but the plan file changed. |
| 5 | Bounce | **Revise mode.** The planner runs again with the existing plan and the latest human comment, appends `## Revision N`, commits `Plan: revision N`. Implementation resumes on the same branch. |
| 6 | Skill packaging | The repo root is a Claude Code plugin `marshall`; the skill is `skills/plan/SKILL.md`, loaded per launch with `--plugin-dir`. User skills do not load in agent sessions (`--setting-sources project,local`). |
| 7 | Model routing | Complexity only. Priority is a classifier input, not an override. Config block `models: { classifier, planSimple, planComplex }`. |
| 8 | Planner clock | `planMinutes: 20`, inside the 2-hour issue clock. No token cap (`--max-budget-usd` is print-only). |

## In scope

### Classifier `src/plan/classify.ts`

- `classifyIssue(issue) → { complexity: "simple" | "complex", reason }`.
- Runs `claude -p --model haiku --output-format json --json-schema <schema> --tools "" --strict-mcp-config --setting-sources project,local` from `~/.marshall`.
- Input: title, description, priority, labels, comment count. No repo access.
- `modelFor()`: `simple → models.planSimple` (opus), `complex → models.planComplex` (fable).

### Skill `skills/plan/SKILL.md`

- The orientation walkthrough from `linear-plan`, no `/grilling`, no questions, no `EnterPlanMode`.
- Sections, in order: TLDR, Where to find it, Orientation, What is wrong and why, Likely touched files, Plan, Decisions made alone, Out of scope found, Verification. Template: `skills/plan/template.md`.
- Writes only `docs/<topic>_plan.md`, commits once, prints the path and SHA.
- Revise mode: updates the affected sections in place, appends `## Revision N`, commits `Plan: revision N`.

### Orchestrator side `src/plan/`

- `runPlanPhase()` — classify, brief, launch, wait, verify, check, post. Public API for step 08 in `src/plan/index.ts`.
- `verifyPlanCommit()` — clean worktree, one commit ahead of the base (fresh) or the newest commit (revise), touching exactly one `docs/*_plan.md`.
- `checkPlanFile()` — the heading check. `bin/marshall plan check <file>` exposes it.
- `bin/marshall plan <identifier> --cwd <worktree> [--revise]` — the phase by hand.

## Out of scope

- Implementation. That is step 05.
- Creating the worktree (step 07). Filing "Out of scope found" items (step 05 or 08).
- Merge detection and the Rebasing phase (step 08).

## Reuse

- `~/.claude/skills/linear-plan/SKILL.md` — the orientation walkthrough, inlined into the skill.
- `~/.claude/skills/brainstorming/` — the ambiguity checklist, inlined as a silent step.
- `src/runner/` — `launch`, `kill`, `startWatcher`, `runClaude`.
- `src/linear/` — `getIssue`, `comment`, `IssueDetail`.

## Deliverables

- `.claude-plugin/plugin.json`, `skills/plan/SKILL.md`, `skills/plan/template.md`.
- `src/plan/{index,types,classify,brief,template,verify,summary,wait,phase}.ts`, `src/git.ts`, `src/cli/plan.ts`.
- `tests/plan/*.test.ts` (classifier through the fake shim, brief snapshot, heading check, git post-check in a temp repo, the whole phase), `tests/plan.live.test.ts`, fixtures under `tests/fixtures/{issues,plans}/`.
- `docs/planning.md`.
- A recorded run: one real ChessBuddy issue planned end to end, with the plan file checked in under `docs/examples/`.

## Acceptance criteria

- [x] `classifyIssue` returns valid JSON for 5 sample issues in under 10 seconds each (`MARSHALL_LIVE=1 bun test tests/plan.live.test.ts`; 4–7 s each on 2026-09-20, all five as a human would label them).
- [x] `runPlanPhase` in a worktree produces the plan file with all required sections, exactly one commit touching only that file, and posts one Linear comment (`tests/plan/phase.test.ts` with the fake shim and a temp repo).
- [x] The plan file passes the section-heading check (`bin/marshall plan check`).
- [x] No `AskUserQuestion` calls appear in the transcript of a real run. Recorded run on CHE-5, 2026-09-20: classified `complex` → Fable, 75 s, one commit touching only the plan file, one Linear comment; tool calls in the transcript were Read ×5, Bash ×4, Write ×1, Edit ×1, no Linear tool in the session. The revise run after a bounce comment took 68 s and added `## Revision 1` in one commit. Plan: [`../examples/health-endpoint-reports-api-version_plan.md`](../examples/health-endpoint-reports-api-version_plan.md).

## Open questions

All five original questions were answered above: skills load through a plugin (#6), the classifier does not estimate touched files because the overlap check is gone (#2), the planner has a clock but no token cap (#8), routing is complexity-only (#7), and the plan is committed (#3).
