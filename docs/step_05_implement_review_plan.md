# Step 05 — Implement and Review Phase — Implementation Plan

<!-- Last edited: 2026-09-20 -->

**TLDR:** Build the robot that turns a plan file into a green pull request.
It is a skill (a recipe file) that a Claude agent follows inside a ChessBuddy worktree: build the change, run the tests, open the PR, wait for CI, then ask a second Claude to review the diff and fix what it finds, up to 4 times.
The skill ships as a plugin inside this repo, because agents cannot see your personal skills.
It reports progress in one JSON file under `~/.marshall/issues/<ISSUE-ID>/` that later steps read.
When it cannot get green, it still opens a draft PR so you can read the work from your phone.
Two agents can run Docker Compose at the same time because each slot gets its own project name and ports.

Step file: `docs/steps/05_implement_and_review_phase.md`. Spec: `docs/project_marshall_plan.md` sections 6.3, 6.4, 11, 12.

## Context

Step 08 (the master agent) needs an implement phase it can start with one command and read the result of without parsing a transcript.
The step file left five open questions.
Two were answered by reading Claude Code's docs and ChessBuddy's repo.
The other three, plus two that the facts surfaced, were decided in a grilling session on 2026-09-20.
Step 04 (planner) is not built yet; this step does not depend on it, but it makes two shared decisions (skill delivery, plan-file ownership) that step 04 must follow.

## Decisions (from grilling, 2026-09-20)

| # | Question | Decision |
|---|---|---|
| 1 | How does the agent get the skill? | **The Marshall repo ships a plugin.** `plugin/.claude-plugin/plugin.json` (`name: marshall`) plus `plugin/skills/<name>/SKILL.md`. The runner launches with `extraArgs: ["--plugin-dir", "<repo>/plugin"]`. Skills are `/marshall:implement`, `/marshall:review`, and later `/marshall:plan`. Not the repo root: a plugin root's `bin/` is added to the agent's `PATH`, and this repo has `bin/marshall`. Answers step 04's open question 1 as well. |
| 2 | Which reviewer, and what blocks? | **Built-in `/code-review` plus a bundled Spec pass.** `/marshall:review` runs the built-in review (bug hunt, `CONFIRMED` / `PLAUSIBLE`) and one sub-agent with the Spec brief from `~/.claude/skills/code-review/` (diff vs the plan file). `CONFIRMED` findings and spec gaps block and get fixed. `PLAUSIBLE` findings never block; they go to `reviewNotes` for the hand-off. |
| 3 | Skill → orchestrator contract | **One JSON file outside the repo:** `$MARSHALL_HOME/issues/<ISSUE-ID>/implement.json`, rewritten at each transition. Followups and review notes live inside it. No `followups.json`, no one-word status file. The skill finds it through `MARSHALL_ISSUE_DIR`, set by the runner in settings `env`. |
| 4 | What happens on red? | **Always end with a PR.** On `tests_red` or `review_exhausted` the PR is a **draft** whose body starts with `## Still failing`. Step 08 marks Blocked; the push carries the PR link. A cycle is: local tests + lint green → push → CI → review → fixes. CI red is fixed inside the same cycle. Four cycles is the cap. |
| 5 | Compose isolation depth | **Env only, stack up on demand.** ChessBuddy's compose file reads `${POSTGRES_HOST_PORT:-5432}`, `${ELASTICMQ_HOST_PORT:-9324}`, `${API_HOST_PORT:-8000}`. The runner puts `COMPOSE_PROJECT_NAME=marshall-<slot>` and the port vars (base + slot × 100) into settings `env`. The skill brings the stack up only when the plan's verification section asks for it, and always runs `docker compose down -v` at the end. |

Decisions taken without a question (cap reached); say so if you want a different call:

- **Plan-file ownership (step file Q5, step 04 Q5):** step 04 commits `docs/<topic>_plan.md` as the first commit on the branch. This skill reads it and never edits it. The plan lands in the PR and is the reviewer's spec source. For this step's recorded run, the plan is hand-written and committed the same way.
- **Skill inputs:** `/marshall:implement <plan-path> <ISSUE-ID>` as arguments (readable in `claude agents`). Env from the runner: `MARSHALL_ISSUE_DIR`, `MARSHALL_ISSUE_URL`, `MARSHALL_SLOT`, `COMPOSE_PROJECT_NAME`, the port vars.
- **House rules ride in the skill:** the agent never loads `~/.claude/CLAUDE.md`, so the skill states the few rules that matter: small commits, no `--no-verify`, no co-author line, keep the `Last edited` stamp on files that already have one, PR title `<ISSUE-ID>: <title>`, body ends with `Closes <issue URL>`.
- **Local gate = ChessBuddy CI, run locally:** `uv run ruff check .`, `uv run ruff format --check .`, `uv run pyright`, `uv run pytest`; plus `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build` in `apps/web` when the diff touches it.
- **Runner change is additive:** `LaunchOpts.env` merges into the settings `env` key. No new CLI command; a `scripts/launch-implement.ts` dev script starts one run by hand until step 08 exists.
- **Recorded run:** the smallest open Todo issue in the ChessBuddy Linear team (confirm the workspace before the first Linear call, per the global rule). Worktree cut by hand, plan hand-written.

## Facts verified

- `--setting-sources project,local` (the runner's flag) drops the `user` source, so `~/.claude/skills/*` never load inside an agent. Docs: skills, commands, and subagents from `--add-dir` load through the `project` source; user-level ones need `user`. Plugin skills are namespaced `/plugin-name:skill-name`; `--plugin-dir` loads a plugin for one session with no install step.
- Plugin layout: `.claude-plugin/plugin.json` (`name`, `description`, `version`) and `skills/<name>/SKILL.md` at the plugin root. A plugin root's `bin/` is put on the Bash `PATH`. `claude plugin validate <dir>` checks the structure.
- Two "code-review"s exist. The personal one (`~/.claude/skills/code-review/`) is two-axis (Standards, Spec) with no verdicts and asks the user for the fixed point. The built-in one reports through `ReportFindings` with `CONFIRMED` / `PLAUSIBLE`. In this session the personal one shadows the built-in; inside an agent only the built-in can exist. **Unverified:** that the built-in loads under `project,local`. Verification step 1 checks it; a fallback is written below.
- ChessBuddy `docker-compose.yml` publishes 5432, 9324, 8000 and sets `name: chessbuddy`. `COMPOSE_PROJECT_NAME` overrides `name:`. Named volumes (`postgres-data`) and built images get the project prefix, so two projects never share a database. Compose interpolation has no arithmetic; per-port vars with defaults are the only file-level option.
- ChessBuddy CI (`.github/workflows/ci.yml`) runs ruff, pyright, pytest with Stockfish installed and **no services**. Tests use fake SQS clients. `worker/main.py` reads `SQS_ENDPOINT_URL` from env; the api gets `DATABASE_URL` from Compose. Tests do not need Compose today.
- ChessBuddy has no `.env` (only `.venv`). Its `.claude/settings.local.json` allows `Bash(uv *)`. Remote is `dvairus/ChessBuddy`; `gh` is logged in as JacquesAttinger.
- Bash state does not persist between an agent's tool calls, so env exported inside one call is gone in the next. Settings `env` applies to every call; `agent-settings.json` already uses it.
- `LaunchOpts.extraArgs` exists for `--plugin-dir`. `buildAgentSettings(runId, base)` spreads `base` and replaces `hooks`; adding `env` is a one-line merge. `src/paths.ts` builds every state path from `marshallHome()`; `ensureHome()` creates the tree. `ConfigSchema` is `.strict()`, so new config keys must be declared.
- Vite (`apps/web`) picks the next free port when 5173 is taken, so host-side dev servers do not collide.

## Layout

New files:

```
plugin/.claude-plugin/plugin.json          name "marshall", version 0.1.0
plugin/skills/implement/SKILL.md           the implementer (this step)
plugin/skills/review/SKILL.md              built-in /code-review + Spec sub-agent
plugin/README.md                           what the plugin is, how to load it by hand
src/isolation.ts                           slotEnv(slot, config) → env record
src/implement/status.ts                    ImplementStatusSchema (Zod), read/parse helpers
scripts/launch-implement.ts                dev launcher: worktree + plan + issue + slot → launch()
tests/isolation.test.ts
tests/implement/status.test.ts
tests/plugin.test.ts                       manifest parses, both SKILL.md files exist and have frontmatter
docs/isolation.md                          slot → project → ports, cleanup, how env reaches the agent
docs/step_05_implement_review_plan.md      this plan, copied after approval
docs/examples/step05_<issue>/              plan.md, implement.json, PR link, cycle count
```

Changed files:

```
src/runner/types.ts          LaunchOpts.env?: Record<string, string>
src/runner/settings.ts       buildAgentSettings(runId, base, env?) merges env
src/runner/launch.ts         passes opts.env through
src/paths.ts                 issueDir(issueId); ensureHome() creates issues/
src/config.ts                services: Record<string, int> (default {}), portOffsetPerSlot (default 100)
marshall.config.json         services: { POSTGRES_HOST_PORT: 5432, ELASTICMQ_HOST_PORT: 9324, API_HOST_PORT: 8000 }
docs/steps/04_planning_phase.md    note: skill delivery and plan ownership decided here
docs/steps/05_implement_and_review_phase.md   decisions recorded, open questions closed
README.md                    plugin section, isolation link
```

ChessBuddy (separate PR, branch `chore/compose-host-port-vars`):

```
docker-compose.yml           three host ports become ${VAR:-default}
README.md                    ports table mentions the vars
```

## The `implement.json` contract

`src/implement/status.ts` owns the schema. Steps 06, 07, 08 import it.

```ts
{
  issueId: string,            // "CB-12"
  slot: number,               // 0 | 1
  phase: "starting" | "implementing" | "testing" | "pr_open" | "reviewing" | "fixing" | "done",
  cycle: number,              // 0 before the first review, then 1..4
  maxCycles: number,          // 4
  branch: string | null,
  prUrl: string | null,
  prDraft: boolean,
  ciState: "pending" | "green" | "red" | null,
  outcome: null | "pr_green" | "review_exhausted" | "tests_red" | "blocked",
  reason: string | null,      // one line, set with tests_red / review_exhausted / blocked
  followups: { title: string, body: string }[],
  reviewNotes: string[],      // PLAUSIBLE findings left as-is, one line each
  updatedAt: string           // ISO
}
```

`readImplementStatus(issueId)` returns the parsed file or `null`. `outcome !== null` means the run ended.

## `plugin/skills/implement/SKILL.md` (outline)

Frontmatter: `name: implement`, `description`, `disable-model-invocation: true` (only the orchestrator calls it).

1. **Preflight.** Parse `$ARGUMENTS` as `<plan-path> <ISSUE-ID>`. Require `MARSHALL_ISSUE_DIR`, `MARSHALL_ISSUE_URL`, `MARSHALL_SLOT`; stop with `outcome: blocked` if missing. Require cwd to be a git worktree on a non-`main` branch. If `implement.json` already exists with `outcome: null`, this is a resume: continue from its `phase` and never open a second PR. Write `phase: starting`.
2. **Read the plan.** Verify its premises against current code (as `ship-plan` step 3). Note the "Out of scope found" section for `followups`.
3. **Implement.** Tests with the change, small commits, house rules above. Write `phase: implementing`.
4. **Local gate.** The ChessBuddy CI commands, run locally. Fix. If still red after an honest effort, go to step 9 with `tests_red`. Write `phase: testing`.
5. **Rebase and push.** `git fetch origin && git rebase origin/main`, push with `-u`.
6. **Open the PR.** `gh pr create --base main --title "<ISSUE-ID>: <title>" --body-file <tmp>`. Body: TLDR, what changed, `## Hand-off` placeholder (step 06 fills it), `Closes <MARSHALL_ISSUE_URL>`. Write `phase: pr_open`, `prUrl`.
7. **Cycle loop, `cycle` 1..4.**
   a. `gh pr checks <url> --watch --fail-level fail`. Red → fix, local gate, push, watch again (same cycle).
   b. Run `/marshall:review <plan-path>`. Write `phase: reviewing`.
   c. No `CONFIRMED` and no spec gaps → `outcome: pr_green`, go to step 9.
   d. Else write `phase: fixing`, fix every blocking finding, local gate, push, `cycle += 1`.
8. **Cap reached.** `outcome: review_exhausted`, `reason` = the count and the first unfixed finding.
9. **Finish.** If `outcome !== pr_green`: `gh pr ready --undo <url>` (or create with `--draft`), prepend `## Still failing` with the failing tests or unfixed findings to the body. If the plan's verification asked for Compose, `docker compose down -v`. Write the final `implement.json` (`phase: done`, `followups`, `reviewNotes`). End with a five-line summary; the `Stop` hook carries it as `last_assistant_message`.

Compose rule, stated once: every `docker compose` call already carries the slot's project name and ports through env; the skill never passes `-p` or edits ports.

Blocked rule: anything outside the agent's control (auth failure, a rebase conflict it cannot resolve, a missing tool) → `outcome: blocked` with a one-line `reason`, PR as draft if one exists.

## `plugin/skills/review/SKILL.md` (outline)

Frontmatter: `name: review`, `description`, argument `<plan-path>`.

1. `git fetch origin`; `base=$(git merge-base origin/main HEAD)`; require a non-empty `git diff $base...HEAD`.
2. Run the built-in `/code-review` on the current branch. Collect findings by verdict.
3. Spawn one `general-purpose` sub-agent with the Spec brief from the personal skill (quoted in full inside SKILL.md, since the sub-agent cannot see it): diff command, commit list, plan-file path; report missing or partial requirements, scope creep, and wrong-looking implementations, quoting the plan line. Under 400 words.
4. Report three lists: `BLOCKING (confirmed)`, `BLOCKING (spec)`, `NOTES (plausible)`. The implement skill acts on the first two.

Fallback if verification step 1 shows the built-in `/code-review` is absent under `project,local`: step 2 becomes a second sub-agent with a bug-hunt brief and a self-verification pass that labels each finding `CONFIRMED` (reproduced by reading the code path) or `PLAUSIBLE`.

## `src/isolation.ts`

```ts
slotEnv(slot: number, config: Config): Record<string, string>
// { MARSHALL_SLOT: "0", COMPOSE_PROJECT_NAME: "marshall-0",
//   POSTGRES_HOST_PORT: "5432", ELASTICMQ_HOST_PORT: "9324", API_HOST_PORT: "8000" }
// slot 1 → "marshall-1", 5532, 9424, 8100
```

Throws on `slot < 0` or `slot >= config.maxAgents`. `implementEnv(issueId, issueUrl, slot, config)` adds `MARSHALL_ISSUE_DIR`, `MARSHALL_ISSUE_URL`.

## `scripts/launch-implement.ts`

`bun scripts/launch-implement.ts --cwd <worktree> --plan docs/x_plan.md --issue CB-12 --slot 0`.
Calls `launch()` with `model: "opus"`, `env: implementEnv(...)`, `extraArgs: ["--plugin-dir", "<repo>/plugin"]`, prompt `/marshall:implement docs/x_plan.md CB-12`. Prints the run id. Step 08 replaces it; step 09 may promote it to a CLI command.

## Implementation order (small commits, one PR on `feat/step-05-implement-review`)

1. Record decisions: update both step files, add `docs/step_05_implement_review_plan.md`.
2. Runner: `LaunchOpts.env`, `buildAgentSettings` env merge, `launch.ts` passthrough. Tests.
3. `src/paths.ts` `issueDir`; `src/implement/status.ts` schema and reader. Tests.
4. `src/config.ts` `services` + `portOffsetPerSlot`; `marshall.config.json`; `src/isolation.ts`. Tests.
5. Plugin: manifest, `review` skill, `implement` skill, README. `tests/plugin.test.ts`. `claude plugin validate plugin`.
6. `scripts/launch-implement.ts`.
7. `docs/isolation.md`; README section.
8. ChessBuddy PR (separate repo, separate branch). Not merged.
9. Recorded run (verification 4). Commit its artifacts under `docs/examples/`.
10. Final: `bun run lint`, `bun run typecheck`, `bun test`, `bun run check:size`. Open the PR. Kill any agent or Compose stack started for verification.

## Verification

1. **Skill visibility (fact check, before writing the skills):** `claude -p --setting-sources project,local --permission-mode bypassPermissions --plugin-dir plugin "List every slash command you can run, one per line, nothing else"` from a temp cwd. Expect `/marshall:implement`, `/marshall:review`, and `/code-review`. Missing `/code-review` → use the fallback in the review skill.
2. **Unit:** `bun test` covers settings env merge, `slotEnv` for slots 0 and 1 and the out-of-range error, `implement.json` round trip and rejection of a bad `outcome`, plugin manifest and frontmatter.
3. **Two-slot Compose (acceptance criterion 1):** two ChessBuddy worktrees on the compose-vars branch. In each: `env $(bun -e 'print slotEnv(N)') docker compose up --wait`, then `curl localhost:8000/health` and `localhost:8100/health`, `docker compose ls` shows `marshall-0` and `marshall-1`, `docker volume ls` shows two `postgres-data` volumes. `docker compose down -v` in both. Record the output in `docs/isolation.md`.
4. **Recorded run (acceptance criteria 2–5):** pick the smallest open Todo issue in ChessBuddy, cut a worktree by hand off `origin/main`, hand-write `docs/<topic>_plan.md` with an "Out of scope found" entry, commit it, launch with `scripts/launch-implement.ts --slot 0`. Watch with `claude agents` and `tail -f ~/.marshall/events/<runId>.jsonl`. Expect: PR title starts with the issue id, CI green, `implement.json` shows `cycle >= 1` and `outcome: pr_green`, `followups` non-empty. Copy plan, `implement.json`, and the PR link into `docs/examples/`.
5. **Exhaustion path (acceptance criterion 4):** run `/marshall:implement` by hand in a scratch worktree with `MARSHALL_MAX_CYCLES=1` and a plan whose spec cannot be met (a requirement the code contradicts). Expect `outcome: review_exhausted`, the PR a draft with `## Still failing`. Close the PR after.
6. **Cleanup:** stop every bg agent started (`claude stop <id>`), `docker compose down -v` in both slots, remove scratch worktrees, leave the recorded-run PR open for your review.

## Out of scope (unchanged from the step file)

- The hand-off package body (step 06 appends to `## Hand-off`).
- Deciding when to run this, resumes, bounces (step 08).
- Creating the worktree and branch (step 07).
- `/marshall:plan` (step 04; it now knows where to live).
