# Marshall plugin

<!-- Last edited: 2026-09-20 11:10 CDT -->

**TLDR:** The skills Marshall's agents run inside a ChessBuddy worktree.
The runner passes `--plugin-dir <this repo>/plugin`, so the skills load in an agent even though `~/.claude/skills` never does (`--setting-sources project,local` drops the `user` source).

| Skill | Invoked as | Who calls it |
|---|---|---|
| `skills/implement/SKILL.md` | `/marshall:implement <plan-path> <ISSUE-ID>` | the orchestrator (step 08), or `scripts/launch-implement.ts` by hand |
| `skills/review/SKILL.md` | `/marshall:review <plan-path>` | `/marshall:implement`, or you on a finished branch |

`implement` has `disable-model-invocation: true`, so it never shows up in an agent's skill list; it only runs when it is the prompt.

## Try it by hand

```bash
claude plugin validate plugin
cd ~/code/ChessBuddy            # any worktree on a feature branch
claude --plugin-dir ~/code/Project_Marshall/plugin "/marshall:review docs/x_plan.md"
```

`implement` needs the env the runner sets (`MARSHALL_ISSUE_DIR`, `MARSHALL_ISSUE_URL`, `MARSHALL_SLOT`, `MARSHALL_MAX_CYCLES`, `COMPOSE_PROJECT_NAME`, the `*_HOST_PORT` vars).
`scripts/launch-implement.ts` sets them; see [`../docs/isolation.md`](../docs/isolation.md) for what each one does.

## Layout rules

Claude Code puts a plugin root's `bin/` on the agent's `PATH`, which is why the plugin lives in `plugin/` and not at the repo root (`bin/marshall` is not for agents).
Add a skill by adding `skills/<name>/SKILL.md` with `name` and `description` in its frontmatter; `tests/plugin.test.ts` checks both.
