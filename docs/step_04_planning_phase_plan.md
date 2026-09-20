# Step 04 — Planning Phase — Implementation Plan

<!-- Last edited: 2026-09-20 10:56 CDT -->

**TLDR:** Build the part of Marshall that turns a Linear issue into a plan file with no human in the loop.
A cheap Haiku call says "simple" or "complex" and that picks Opus or Fable.
The orchestrator writes a brief file, launches a `/marshall:plan` agent in the worktree, and the agent writes and commits `docs/<topic>_plan.md`.
After the run, the orchestrator proves the agent changed nothing else, then posts the plan's TLDR to Linear.
The agent never touches Linear.
One decision from grilling reaches outside this step: there is no overlap check at pickup any more; conflicts are resolved after a merge instead.

Step file: `docs/steps/04_planning_phase.md`. Spec: `docs/project_marshall_plan.md` sections 5.3, 5.4, 6.1, 6.2, 7.1, 11, 12, 14.

## Context

Step 08 (master agent) needs one call, `runPlanPhase()`, that takes a claimed issue and a worktree and returns a validated plan file path, or a reason it failed.
Step 06 (hand-off) reads the plan's orientation section.
Step 07 (queue) needs to know whether the classifier runs before or after the claim.
The step file left five open questions.
One was answered by facts (user skills do not load in agent sessions).
The rest, plus four more that the facts surfaced, were decided in a grilling session on 2026-09-20.

## Decisions (from grilling)

| # | Question | Decision |
|---|---|---|
| 1 | Who talks to Linear during planning | **Orchestrator only.** It fetches the issue with `LinearClient.getIssue()`, writes a brief file, and passes the path to the skill. After the run it posts the plan's TLDR and "Decisions made alone" as one comment. The agent has no Linear access. The runner adds `--strict-mcp-config` so the claude.ai Linear connector (authenticated to the personal account, not `MARSHALL_LINEAR_API_KEY`) never reaches an agent. |
| 2 | Overlap check | **Dropped.** Two agents may touch the same code. Conflicts are handled after a merge: deterministic `git rebase origin/main` on every other open Marshall PR, a resolver agent only when the rebase conflicts or CI goes red, then the full done gate again and a re-posted hand-off. The classifier stays complexity-only with no repo access. The spec and steps 07 and 08 are amended in this PR. |
| 3 | Plan location | **Committed on the issue branch** as `docs/<topic>_plan.md`, one commit `Plan: <issue title>`. Survives a lost worktree, is visible in the PR, and matches ChessBuddy's existing `docs/*_plan.md` practice. |
| 4 | Write boundary | **bypassPermissions + post-check.** Plan mode cannot be used (it blocks every write except `~/.claude/plans/<slug>.md`). The skill says "write only the plan file, make one commit". The orchestrator verifies with git that nothing else changed. |
| 5 | Bounce | **Revise mode.** On a bounce the planner runs again with the existing plan and the latest human comment, appends `## Revision N`, updates the Decisions and Verification sections, and commits `Plan: revision N`. Implementation then resumes on the same branch. Step 08's "skip Planning on a bounce" is amended. |

Recommendations taken without a question:

- **Packaging:** the repo root becomes a Claude Code plugin named `marshall` (`.claude-plugin/plugin.json`). The skill lives at `skills/plan/SKILL.md` and is invoked as `/marshall:plan`. The launch passes `--plugin-dir <repo root>` through `extraArgs`. Later steps add their skills to the same plugin.
- **Brief file:** `~/.marshall/briefs/<runId>.md`. Holds identifier, title, URL, priority, labels, branch name, description, comments oldest first with "you" or "Marshall" marked, and in revise mode the plan path plus the latest human comment. The prompt is `/marshall:plan <brief path>`.
- **Classifier run:** `claude -p --model haiku --output-format json --json-schema <schema> --tools "" --strict-mcp-config --setting-sources project,local <prompt>` with cwd `~/.marshall`, so no project settings or MCP servers load and the Max login still works. Schema comes from zod via `z.toJSONSchema`. 60 s timeout through the existing `runClaude`.
- **Model routing:** complexity only. Priority is an input to the classifier, not an override. New config block `models: { classifier, planSimple, planComplex }` with defaults `haiku`, `opus`, `fable`.
- **Planner clock:** `planMinutes: 20` in config, inside the 2-hour issue clock. Step 08 kills on expiry. `--max-budget-usd` only works with `--print`, so there is no token cap for a `--bg` run.
- **Post-check:** worktree clean (`git status --porcelain` empty), and the commits ahead of the base touch exactly the plan file. Fresh mode: one commit. Revise mode: the newest commit touches only the plan file. Then the heading check against `docs/plan_template.md`.
- **Entry points:** `runPlanPhase()` in `src/plan/index.ts` for step 08, and `bin/marshall plan <identifier> --cwd <worktree> [--revise]` for the recorded example run and for manual tests.
- **Tests:** the fake-claude shim gains a `-p` branch that prints canned JSON. `MARSHALL_LIVE=1` runs the classifier against the real Haiku on 5 sample issues. The full example run is done by hand and checked in under `docs/examples/`.
- **Naming:** `src/runner/index.ts` already exports `classify` (hook events). The new function is `classifyIssue` in `src/plan/classify.ts`.

## Facts verified

- The runner launches with `--setting-sources project,local`. Per the Agent SDK docs, the `user` source is what loads `~/.claude/skills/`, `~/.claude/commands/`, `~/.claude/agents/`, and `~/.claude/CLAUDE.md`. So a symlink into `~/.claude/skills/` does nothing for agents.
- Plugin layout: `<plugin>/.claude-plugin/plugin.json` plus `<plugin>/skills/<name>/SKILL.md`. Skills load as `/<plugin>:<name>`. `--plugin-dir <path>` loads one for the session (Claude Code 2.1.278 here).
- `--add-dir <dir>` also loads `<dir>/.claude/skills/`, but it grants file access as a side effect and ties the skill to a `.claude/` folder. The plugin is cleaner.
- claude.ai MCP connectors (Linear, Gmail, Slack, Calendar) load in every session that authenticates with the claude.ai login, regardless of `--setting-sources`. `--strict-mcp-config` is the documented way to drop them.
- `claude -p` accepts `--output-format json`, `--json-schema <schema>`, `--tools ""` (no tools), `--max-budget-usd` (print only), `--strict-mcp-config`.
- Plan mode blocks writes to every path except the assigned `~/.claude/plans/<slug>.md`. The slug is random, so an orchestrator cannot predict which file is ours.
- `LinearClient` (`src/linear/client.ts`) already has `getIssue()`, `comment()`, and `IssueDetail` with `branchName`, `comments[]`, `latestHumanComment`, `priority`, `labels`.
- `runClaude(args, { cwd, timeoutMs })` in `src/runner/claude.ts` runs any `claude` subcommand to completion and returns stdout. It strips `CLAUDECODE` so a nested run is not refused.
- `startWatcher(db, onTerminal)` and `processRun` in `src/runner/events.ts` deliver the terminal event for a run. `runPlanPhase` can await a promise resolved from `onTerminal`.
- ChessBuddy already keeps `docs/*_plan.md` files (`m0_bootstrap_plan.md`, `m1_analysis_core_plan.md`, ...). Committing a plan per issue follows the house style.
- `resolving-merge-conflicts` and `code-review` exist in `~/.claude/skills/` and must be copied into the plugin before steps 05 and 08 can use them. Not in this step.
- zod is `^4.6.5`, which has `z.toJSONSchema`.

## Layout

New files:

```
.claude-plugin/plugin.json          name "marshall", version, description
skills/plan/SKILL.md                the autonomous planner skill
docs/plan_template.md               required sections, in order, with one line each on what goes there
docs/planning.md                    how the phase works, the brief format, the checks, how to run it by hand
docs/examples/<topic>_plan.md       one real ChessBuddy plan (added at the end, by hand)
docs/step_04_planning_phase_plan.md this plan, copied after approval
src/plan/index.ts                   runPlanPhase(); public API for step 08
src/plan/classify.ts                classifyIssue(); prompt, zod schema, runClaude call, parse
src/plan/brief.ts                   writeBrief(); renders IssueDetail (+ plan path, latest comment) to Markdown
src/plan/template.ts                REQUIRED_SECTIONS, checkPlanFile(path) → {ok, missing[]}
src/plan/verify.ts                  verifyPlanCommit(cwd, base, planPath, mode) → git checks
src/plan/types.ts                   PlanPhaseInput, PlanPhaseResult, Complexity, Classification
src/cli/plan.ts                     `marshall plan <identifier> --cwd <dir> [--revise] [--json]`
tests/plan/classify.test.ts         golden issues through the fake shim; parse errors; timeout
tests/plan/brief.test.ts            rendered brief snapshot for fresh and revise
tests/plan/template.test.ts         heading check on good, missing, and reordered files
tests/plan/verify.test.ts           temp git repo: clean, extra file, extra commit, revise
tests/plan/phase.test.ts            runPlanPhase with fake claude, fake Linear, temp git worktree
tests/plan.live.test.ts             MARSHALL_LIVE=1: 5 sample issues through real Haiku, < 10 s each
tests/fixtures/issues/*.json        5 sample IssueDetail objects
tests/fixtures/plans/*.md           good and bad plan files
```

Changed files:

```
src/config.ts                       models block, planMinutes
marshall.config.json                same
src/runner/launch.ts                --strict-mcp-config in buildArgv (before --settings)
tests/runner/launch.test.ts         argv assertion
tests/fixtures/fake-claude          `-p` branch: print $FAKE_CLAUDE_DIR/print.json, else a default envelope
src/cli/index.ts                    register `plan`, add --cwd and --revise to parseArgs
src/paths.ts                        briefsDir()
README.md                           plugin note, `marshall plan`, links
docs/steps/04_planning_phase.md     decisions recorded, open questions closed
docs/steps/07_queue_and_scheduler.md  overlap check removed from scope and deliverables
docs/steps/08_master_agent_state_machine.md  bounce runs Planning in revise mode; add merge detection + Rebasing phase
docs/project_marshall_plan.md       sections 5.3 step 4, 5.4, 8.2, 11, 13, 14, 15 #12, "Still open"
docs/runner.md                      --strict-mcp-config on the command line
```

## Work plan

### 1. Plugin and runner

- Add `.claude-plugin/plugin.json` with `name: "marshall"`.
- Add `--strict-mcp-config` to `buildArgv` in `src/runner/launch.ts` and update the argv test and `docs/runner.md`.
- Export `PLUGIN_DIR` (the repo root) from `src/plan/index.ts` so callers pass `extraArgs: ["--plugin-dir", PLUGIN_DIR]`.

### 2. Config

- `ConfigSchema` gains `models: z.object({ classifier, planSimple, planComplex }).strict()` with the defaults above, and `planMinutes: positiveInt.default(20)`.
- `marshall.config.json` gets both keys written out.
- `tests/config.test.ts` covers the defaults and a bad model key.

### 3. Classifier `src/plan/classify.ts`

- `classifyIssue(issue: PickableIssue, opts?) → Promise<Classification>` where `Classification = { complexity: "simple" | "complex", reason: string }`.
- Prompt: one system-style preamble that defines "simple" (one area, clear fix, no schema or cross-module change) and "complex" (new feature, several areas, design choices, migrations), then the issue fields: title, description, priority (as a word), labels, comment count.
- `ClassificationSchema` in zod; `z.toJSONSchema(ClassificationSchema)` becomes `--json-schema`.
- Runs `runClaude(["-p", ...flags, prompt], { cwd: marshallHome(), timeoutMs: 60_000 })`.
- Parses the `--output-format json` envelope and reads `structured_output`; falls back to parsing `result` as JSON. Invalid → `PlanError("classifier_bad_output")`.
- `modelFor(classification, config)` returns `config.models.planSimple` or `planComplex`.

### 4. Brief `src/plan/brief.ts`

- `writeBrief(input) → path` writes `briefsDir()/<runId>.md`.
- Fresh mode sections: Issue (identifier, title, URL, priority, labels, branch), Description, Comments (each with "You" or "Marshall", date, body).
- Revise mode adds: Existing plan (path), Latest comment from you (verbatim), Revision number.
- No instructions in the brief; instructions live in the skill.

### 5. Template and heading check `src/plan/template.ts` + `docs/plan_template.md`

Required H2 sections, in this order:

1. `TLDR` (the `**TLDR:**` paragraph directly under the H1 counts)
2. `Where to find it`
3. `Orientation`
4. `What is wrong and why`
5. `Likely touched files`
6. `Plan`
7. `Decisions made alone`
8. `Out of scope found`
9. `Verification`

Revise mode appends `## Revision N` after `Verification`, holding: your comment verbatim, what changed in the plan, and which of the sections above were updated.
`checkPlanFile(path)` returns the missing or misordered headings.
`bin/marshall plan check <file>` exposes it.

### 6. Post-check `src/plan/verify.ts`

- `verifyPlanCommit({ cwd, base, planPath, mode })`.
- Runs `git status --porcelain` (must be empty), `git rev-list --count <base>..HEAD`, `git diff --name-only <base>..HEAD`.
- Fresh: exactly 1 commit, exactly `[planPath]`.
- Revise: `git diff --name-only HEAD~1..HEAD` is exactly `[planPath]`.
- Returns `{ ok: true }` or `{ ok: false, reason, files }`.
- Uses `Bun.spawn` with `git`, same shape as `runClaude` (a small `runGit` helper here; step 07's `worktree.ts` can move it to `src/git.ts` later).

### 7. `runPlanPhase` `src/plan/index.ts`

```
runPlanPhase({ db, linear, config, issue: IssueDetail, cwd, mode: "fresh" | "revise", revision?, onLaunched? })
  → { ok: true, planPath, classification, model, runId }
  | { ok: false, reason: "classifier_failed" | "launch_failed" | "run_failed" | "timeout" | "unexpected_changes" | "missing_sections", detail, runId? }
```

1. Fresh: `classifyIssue` → model. Revise: reuse the stored model (caller passes it) and skip the call.
2. `writeBrief`.
3. `launch(db, { name: issue.identifier, cwd, model, prompt: "/marshall:plan <brief>", extraArgs: ["--plugin-dir", PLUGIN_DIR] })`.
4. Await the terminal event through `startWatcher` (or a caller-provided watcher; step 08 will own one). Time out after `config.planMinutes` and `kill`.
5. Find the plan file: the newest `docs/*_plan.md` in the diff against the base. Reject if more than one.
6. `verifyPlanCommit`, then `checkPlanFile`.
7. `linear.comment(issue.id, renderSummary(planPath))` where the summary is the TLDR paragraph, the "Decisions made alone" bullets, and the branch name.
8. Return.

Each of these is a small function so nothing crosses 75 lines.

### 8. Skill `skills/plan/SKILL.md`

Frontmatter: `name: plan`, description "Autonomous planner for Marshall. Reads a brief file, explores the repo, writes and commits a plan. Never asks questions."

Body, in order:

1. Read the brief at the given path. It is the only source for the issue. Do not fetch Linear.
2. You have no human. Never call `AskUserQuestion`, never ask a question in text, never call `EnterPlanMode`. When a decision is yours, make it and record it under "Decisions made alone".
3. Explore the repo enough to understand the problem. Read code, do not guess. Run the brainstorming ambiguity checklist silently; every ambiguity becomes a decision.
4. Orientation walkthrough, as `linear-plan` does it: UI path or "not UI-reachable", area → part → section, then what is wrong and the shape of the fix.
5. Write `docs/<topic>_plan.md` from `docs/plan_template.md` (copied into the skill folder as `template.md` so it is reachable in any cwd). `<topic>` is a short kebab slug from the issue title. TLDR first, one sentence per line, dated comment on line 3.
6. Fill "Likely touched files" with paths or globs. Fill "Out of scope found" with title + one-line description per item; step 05 or 08 files them.
7. Do not edit any other file. Do not run formatters or install commands. Do not push.
8. `git add docs/<topic>_plan.md && git commit -m "Plan: <issue title>"`.
9. Revise mode (the brief has a "Revision" section): read the existing plan, append `## Revision N`, update the sections the comment affects in place, commit `Plan: revision N`.
10. Finish with one line: the plan path and the commit SHA. Nothing else.

### 9. CLI `src/cli/plan.ts`

- `marshall plan <identifier> --cwd <worktree> [--revise] [--json]`: connects Linear, `getIssue` by identifier, opens the DB, starts a watcher, calls `runPlanPhase`, prints the result, stops the watcher. Exit 0 on `ok`, 1 otherwise.
- `marshall plan check <file>`: heading check only.
- `parseArgs` in `src/cli/index.ts` gains `--cwd <path>` and `--revise`.

### 10. Tests

- Fake shim `-p` branch: prints `$FAKE_CLAUDE_DIR/print.json` if present, else `{"type":"result","structured_output":{"complexity":"simple","reason":"canned"}}`.
- `phase.test.ts` drives the whole thing: temp bare repo + worktree, fake claude whose `--bg` branch runs a tiny script that writes the plan file and commits (a second shim mode, `FAKE_CLAUDE_PLAN_SCRIPT`), then the test appends a `Stop` line to the events file and the watcher finishes the run. Fake Linear records the comment. Cases: happy fresh, happy revise, extra file → `unexpected_changes`, missing section → `missing_sections`, timeout → `timeout` + kill.
- Live: `tests/plan.live.test.ts` classifies the 5 fixtures with real Haiku and asserts valid JSON under 10 s each.

### 11. Docs

- Update `docs/steps/04_planning_phase.md`: decisions table, open questions closed, deliverables renamed (`skills/plan/`).
- Amend step 07: remove the overlap check from Goal, In scope, Deliverables, Acceptance, and open question 2. Replace with "No overlap check in iteration 1; see step 08 Rebasing".
- Amend step 08: Bounce runs Planning in revise mode before Implementing; add "Merge detection: poll `gh pr view --json mergedAt` for open Marshall PRs each tick; on a merge, rebase every other open Marshall PR; clean + CI green → re-post hand-off with a badge; conflict or red → launch a resolver run with `/marshall:resolve-conflicts`, then the full done gate, then push a notification".
- Amend the spec: 5.3 step 4 removed; 5.4 rewritten as "Conflict resolution after merge"; 8.2 drops "waiting on the overlap check"; 11 and 13 drop the overlap check; 14 row "Parallel agents collide" → new mitigation; 15 #12 → "Global cap. Worktrees always. No overlap check; rebase after merge."; "Still open" drops the heuristic item.
- `docs/planning.md` and README.

## Order of work

1. Plugin file, runner flag, config. Small, unblocks everything.
2. Template + check. Brief. Verify. Each with its test.
3. Classifier + fake shim `-p` + tests.
4. Skill.
5. `runPlanPhase` + phase test.
6. CLI.
7. Docs and spec amendments.
8. Lint, typecheck, size check, full tests once at the end.
9. Live classifier test, then the real example run on one ChessBuddy issue (you pick the issue). Check the plan in under `docs/examples/`.

## Verification

- `bun test` green, including the new `tests/plan/*`.
- `bun run lint`, `bun run typecheck`, `bun run check:size` clean.
- `MARSHALL_LIVE=1 bun test tests/plan.live.test.ts`: 5 classifications, valid JSON, under 10 s each.
- Real run: in a fresh ChessBuddy worktree on the issue's branch, `bin/marshall plan CB-<n> --cwd <worktree>`. Expected: the plan file exists with all 9 sections, exactly one commit on the branch touching only that file, one Linear comment with the Marshall footer, the transcript has no `AskUserQuestion` (grep the transcript JSONL from `transcriptPath()`).
- Revise run on the same worktree: add a comment on the issue, run with `--revise`. Expected: `## Revision 1` appended, one new commit touching only the plan file.
- Runner live test still passes with `--strict-mcp-config`: `MARSHALL_LIVE=1 bun test tests/runner.live.test.ts`.
- Kill every process opened during verification before reporting done.

## Out of scope

- Implementation, review, hand-off (steps 05, 06).
- Merge detection, the Rebasing phase, and the `resolve-conflicts` skill in the plugin (step 08, recorded there by this PR).
- Filing the "Out of scope found" items as Linear issues (step 05 or 08).
- Creating the worktree (step 07).
