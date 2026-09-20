# Planning phase — how it works

<!-- Last edited: 2026-09-20 10:56 CDT -->

**TLDR:** Marshall turns a claimed Linear issue into a committed plan file with no human in the loop.
A cheap Haiku call says "simple" or "complex", which picks Opus or Fable.
The orchestrator writes a brief file, launches a `/marshall:plan` agent in the worktree, and the agent writes and commits `docs/<topic>_plan.md`.
After the run, git proves the agent changed nothing else, the headings are checked, and the plan's TLDR is posted to Linear.
The agent never talks to Linear.

## The one call

```ts
import { runPlanPhase } from "./src/plan/index.ts";

const result = await runPlanPhase({ db, linear, config, issue, cwd, mode: "fresh" });
// { ok: true, planPath: "docs/fix-castling_plan.md", classification, model, runId, briefPath }
// { ok: false, reason: "classifier_failed" | "launch_failed" | "run_failed" | "timeout"
//                    | "unexpected_changes" | "missing_sections", detail, runId?, briefPath? }
```

`issue` is an `IssueDetail` from `LinearClient.getIssue()`.
`cwd` is the issue's worktree, already on the issue branch.
`base` defaults to `origin/<config.baseBranch>`.
`mode: "revise"` is for a bounce: the plan exists on the branch and a human commented.
`model` skips the classifier (step 08 passes the model it stored at the first run).
`waiter` is a `RunWaiter`; step 08 supplies one built on its single watcher, the CLI makes its own with `createRunWaiter(db)`.

## Steps, in order

1. **Classify.** `classifyIssue(issue)` runs `claude -p` with the issue's title, description, priority (as a word), labels, and comment count.
   No repo access, no tools, no MCP.
   The answer is `{ complexity: "simple" | "complex", reason }`.
   `simple` plans with `config.models.planSimple` (Opus), `complex` with `config.models.planComplex` (Fable).
   Priority is an input to the classifier, never an override.
2. **Brief.** `writeBrief()` renders the issue to `~/.marshall/briefs/<runId>.md`.
   The brief holds facts only; the instructions live in the skill.
3. **Launch.** `launch()` from the runner with `--model <picked>`, `--plugin-dir <Marshall repo root>`, and the prompt `/marshall:plan <brief path>`.
   The runner adds `--strict-mcp-config`, so the claude.ai Linear connector never reaches an agent.
4. **Wait.** The waiter resolves on the run's terminal hook event.
   After `config.planMinutes` (20) with no `Stop`, the run is killed and the result is `timeout`.
5. **Verify with git.** `verifyPlanCommit()`: the worktree is clean, the branch is exactly one commit ahead of the base (fresh) or the newest commit is the revision (revise), and that commit touches exactly one `docs/*_plan.md`.
   Anything else is `unexpected_changes`, with the offending files in `detail`.
6. **Check headings.** `checkPlanFile()` requires these H2 sections in this order: `TLDR` (a `**TLDR:**` paragraph under the H1 also counts), `Where to find it`, `Orientation`, `What is wrong and why`, `Likely touched files`, `Plan`, `Decisions made alone`, `Out of scope found`, `Verification`.
   Revise mode also requires `## Revision N`.
7. **Post.** One Linear comment: the TLDR, the "Decisions made alone" bullets, the plan path, and the branch.
   In revise mode the comment also carries the "Revision N" section.

## The brief

```markdown
# CB-12 — Fix castling through check

<!-- Brief written by Marshall at 2026-09-20T16:00:00.000Z for run cb-12-plan-01234567 -->

## Issue

- Identifier: CB-12
- Title: Fix castling through check
- URL: https://linear.app/chessbuddy/issue/CB-12
- Priority: High
- Labels: bug
- Branch: cb-12-fix-castling-through-check

## Description

The king can castle while the square it crosses is attacked.

## Comments

### You — 2026-09-19T01:00:00Z

First thought.

### Marshall — 2026-09-19T02:00:00Z

Plan posted.
```

Revise mode appends:

```markdown
## Revision

- Number: 1
- Existing plan: docs/fix-castling_plan.md

### Latest comment from you

2026-09-19T03:00:00Z

Use a helper, not inline.
```

## The skill

The repo root is a Claude Code plugin named `marshall` (`.claude-plugin/plugin.json`).
The planner is `skills/plan/SKILL.md`, invoked as `/marshall:plan <brief path>`; its template is `skills/plan/template.md`.
Later steps add `implement` and `resolve-conflicts` to the same plugin.

Why a plugin: agents launch with `--setting-sources project,local`, and only the `user` source loads `~/.claude/skills/`.
So a symlink into `~/.claude/skills/` does nothing for agents, and `--add-dir` would grant file access as a side effect.
`--plugin-dir <path>` loads the plugin for one session and nothing else.

The skill runs under `bypassPermissions`.
Plan mode cannot be used: it blocks every write except `~/.claude/plans/<random slug>.md`, and the orchestrator cannot predict the slug.
The write boundary is enforced after the fact by step 5 above.

## The classifier command line

```
claude -p --model haiku --output-format json --json-schema '<schema>' --tools "" \
  --strict-mcp-config --setting-sources project,local '<prompt>'
```

Run from `~/.marshall` (`MARSHALL_HOME`), so no project settings load and the Max login still works.
The schema is `z.toJSONSchema(ClassificationSchema)` minus its `$schema` key: Claude Code's validator rejects the draft URL zod emits ("no schema with key or ref ...").
The answer is read from the envelope's `structured_output`, then from `result` as JSON text, then from a bare object.
60 s timeout through `runClaude`.

Observed on 2026-09-20 with Claude Code 2.1.278: 4–7 s per call, and all five fixtures in `tests/fixtures/issues/` classified the way a human would.
`--max-budget-usd` only works with `--print`, so there is no token cap on the planner itself; the clock is the cap.

## A recorded run

[`examples/health-endpoint-reports-api-version_plan.md`](examples/health-endpoint-reports-api-version_plan.md) is the verbatim output of `bin/marshall plan CHE-5` on a fresh ChessBuddy worktree on 2026-09-20, plus the `## Revision 1` that `--revise` appended after a bounce comment.
Fresh run: Haiku said `complex` (a public interface changes), Fable planned it in 75 s, one commit, nine sections, one Linear comment.
Revise run: 68 s, one more commit touching only the plan.
The transcript held no `AskUserQuestion` or `EnterPlanMode` call and no Linear tool.

## Running it by hand

```bash
bin/marshall plan CB-12 --cwd ~/code/ChessBuddy-cb-12-fix-castling   # fresh
bin/marshall plan CB-12 --cwd ~/code/ChessBuddy-cb-12-fix-castling --revise
bin/marshall plan check docs/fix-castling_plan.md                    # headings only
```

`plan` connects to Linear with `MARSHALL_LINEAR_API_KEY`, fetches the issue by identifier, opens `~/.marshall/marshall.db`, runs the phase, prints the result, and exits 0 on `ok`.
The worktree must exist and be on the issue branch (step 07 creates it in the loop).
`--revise` finds the plan on the branch and numbers the revision one past the newest `## Revision N` in it.

## Tests

- `bun test tests/plan/` — the fake `claude` shim answers `-p` with a canned classification and runs a test script in place of the planner for `--bg`.
  The phase test drives fresh, revise, extra file, dirty worktree, missing section, StopFailure, timeout, and launch failure against a temp git repo with an `origin`.
- `MARSHALL_LIVE=1 bun test tests/plan.live.test.ts` — the five fixtures through the real Haiku, under 10 s each.

## Facts learned the hard way

- A git hook exports `GIT_DIR` and `GIT_INDEX_FILE` to its children.
  The pre-commit run of the test suite made the fake planner's `git commit` land on Marshall's own branch.
  `runClaude` and `runGit` now strip git's repo-location variables, so an agent started from a hook commits to its own worktree.
- `claude -p --plugin-dir <root> "/marshall:plan /missing"` answers `BRIEF_MISSING /missing` after about 5 s of API time, then the process lingers about two minutes before it exits (observed twice, with stdin closed).
  The classifier, which loads no plugin, exits in 4–7 s.
  The planner itself runs under `--bg`, and the phase reads its end from the `Stop` hook, not from the process exit, so the lag does not reach the loop.
