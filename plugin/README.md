# Marshall plugin

<!-- Last edited: 2026-09-20 17:00 CDT -->

**TLDR:** The skills Marshall's agents run inside a ChessBuddy worktree.
The runner passes `--plugin-dir <this repo>/plugin`, so the skills load in an agent even though `~/.claude/skills` never does (`--setting-sources project,local` drops the `user` source).

| Skill | Invoked as | Who calls it |
|---|---|---|
| `skills/plan/SKILL.md` | `/marshall:plan <brief-path>` | `runPlanPhase` (`src/plan/phase.ts`); see `docs/planning.md` |
| `skills/implement/SKILL.md` | `/marshall:implement <plan-path> <ISSUE-ID>` | the orchestrator (step 08), or `scripts/launch-implement.ts` by hand |
| `skills/review/SKILL.md` | `/marshall:review <plan-path>` | `/marshall:implement`, or you on a finished branch |
| `skills/handoff/SKILL.md` | `/marshall:handoff <plan-path> <ISSUE-ID>` | `runHandoffPhase` (`src/handoff/phase.ts`), or `scripts/launch-handoff.ts` by hand; see `docs/handoff.md` |

`implement` and `handoff` have `disable-model-invocation: true`, so they never show up in an agent's skill list; each only runs when it is the prompt.

## Try it by hand

```bash
claude plugin validate plugin
cd ~/code/ChessBuddy            # any worktree on a feature branch
claude --plugin-dir ~/code/Project_Marshall/plugin "/marshall:review docs/x_plan.md"
```

`implement` needs the env the runner sets (`MARSHALL_ISSUE_DIR`, `MARSHALL_ISSUE_URL`, `MARSHALL_SLOT`, `MARSHALL_MAX_CYCLES`, `COMPOSE_PROJECT_NAME`, the `*_HOST_PORT` vars).
`scripts/launch-implement.ts` sets them; see [`../docs/isolation.md`](../docs/isolation.md) for what each one does.
`handoff` needs `MARSHALL_ISSUE_DIR`, `MARSHALL_ISSUE_URL`, `MARSHALL_HANDOFF_PATH`, `MARSHALL_ROUND`, `MARSHALL_BASE_BRANCH`, and `MARSHALL_PR_URL`; `scripts/launch-handoff.ts` sets them.

## Layout rules

Claude Code puts a plugin root's `bin/` on the agent's `PATH`, which is why the plugin lives in `plugin/` and not at the repo root (`bin/marshall` is not for agents).
Add a skill by adding `skills/<name>/SKILL.md` with `name` and `description` in its frontmatter; `tests/plugin.test.ts` checks both.
