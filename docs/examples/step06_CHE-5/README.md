# Recorded hand-off — CHE-5, 2026-09-20

<!-- Last edited: 2026-09-20 17:25 CDT -->

**TLDR:** The hand-off writer read the CHE-5 plan, diff, and PR, and wrote a valid six-section package on its first try, in under a minute.
The package went to Linear as one comment and into PR #36's body between the markers.
A second post with a badge edited the same comment and the same PR section, and changed no byte outside the markers.

| | |
|---|---|
| Issue | [CHE-5 — Health endpoint reports the API version](https://linear.app/chessbuddy/issue/CHE-5/health-endpoint-reports-the-api-version) |
| PR | https://github.com/dvairus/ChessBuddy/pull/36 (open, green, from the [step 05 run](../step05_CHE-5/README.md)) |
| Worktree | `~/code/ChessBuddy/.worktrees/che-5`, branch `jacques/che-5-health-endpoint-reports-the-api-version`, clean before and after |
| Model | Opus (`models.handoff`) |
| Launch | `bun scripts/launch-handoff.ts --cwd <worktree> --plan docs/health_version_plan.md --issue CHE-5 --post` |
| Run | `che-5-handoff-22302f38`, job `0bad68a6`; `resumed: false` |
| Wall clock | 56 s from launch to the PR body edit |

Files here:

- `handoff.md` — `~/.marshall/handoffs/CHE-5.md`, verbatim. `bin/marshall handoff check` on it exits 0.
- `handoff.json` — the sidecar after the first post: comment id, round 1, PR URL.
- `pr_body_before.md` — PR #36's body as the implement skill left it: the bare `_Filled in by the hand-off step._` line under `## Hand-off` (the legacy shape, before the markers were added to the skill).
- `pr_body_after.md` — the body after the first post: the placeholder became `<!-- marshall-handoff:start -->` … `<!-- marshall-handoff:end -->` around the package (`prAction: "filled_placeholder"`), and every byte before and after is unchanged, `Closes` included.

## The three posts

1. `--post`: `commentAction: "created"` (comment `0b0bed97-…`), PR body filled, sidecar written.
2. `--post-only --badge "rebased after https://github.com/dvairus/ChessBuddy/pull/1"` (2 s): `commentAction: "updated"` on the same comment, `prAction: "replaced"`.
   The Linear issue still had four comments.
   The PR body had one `## Hand-off`, one marker pair, and the line `_rebased after …_` right under the TLDR; the bytes outside the markers matched post 1 exactly.
   The sidecar gained `"badge"`.
3. `--post-only` with no badge (2 s), to leave the real PR truthful: the body came back byte-identical to `pr_body_after.md`, and the sidecar lost `"badge"`.

## Reading section 2 cold

"Where to find it" says the feature is not UI-reachable, names the endpoint, and gives the two commands (`docker compose up --wait`, then `curl http://localhost:8000/health`) plus the OpenAPI page where the same string shows.
A reader who has never opened ChessBuddy can reach `GET /health` from that section alone.

## What the run showed

- The skill's preflight (`gh pr view`), the diff pin (`git merge-base origin/main HEAD`), and the read of `implement.json` all worked with the six env vars alone; the agent never looked for a Linear tool.
- Section 5 lists three files that matter (two source, plus the plan) and carries the review notes (`(none)`) and the one follow-up title from `implement.json`.
- The writer left the worktree clean: `git status --porcelain` was empty and `HEAD` unchanged, so the phase never hit `worktree_dirty`.
