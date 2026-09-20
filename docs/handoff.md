# Hand-off phase — how it works

<!-- Last edited: 2026-09-20 17:30 CDT -->

**TLDR:** After an issue's PR is green, a small read-only agent writes a six-section note: where the feature is, what was wrong, what changed, and how to check it.
Marshall checks the note's shape, posts it to Linear as one comment, and splices it into the PR body between two marker lines.
A re-post (a bounce, or a rebase) edits the same comment and the same PR section instead of adding more.
The agent never talks to Linear or edits the PR; it writes one file and stops.

## The one call

```ts
import { runHandoffPhase } from "./src/handoff/index.ts";

const result = await runHandoffPhase({ db, linear, config, issue, cwd, planPath });
// { ok: true, handoffPath, metaPath, commentId, round, prUrl, model, runId, resumed }
// { ok: false, reason: "no_pr" | "worktree_dirty" | "launch_failed" | "run_failed" | "timeout"
//                    | "handoff_invalid" | "post_failed", detail, runId?, handoffPath? }
```

`issue` is an `IssueDetail` from `LinearClient.getIssue()` (`id` is the UUID Linear wants, `identifier` names the files).
`cwd` is the issue's worktree, on the issue branch, with the PR open.
`planPath` is the plan file relative to `cwd`, from the claim.
`round` defaults to the sidecar's round + 1 (1 on the first post); step 08 passes the bounce count.
`model` defaults to `handoffModel(config)`: `models.handoff`, else `models.planSimple`.
`waiter` is a `RunWaiter`, as for `runPlanPhase`.

Two smaller calls exist for step 08's other paths:

- `writeHandoff(input)` — the writer alone, validated, nothing posted.
- `postHandoff({ issue, linear, prUrl, cwd, round, badge? })` — post the file that is already at `~/.marshall/handoffs/<ID>.md`.
  The rebase path calls this with `badge: "rebased after <PR URL>"` and no new writer run.

## Steps, in order

1. **Preflight.** `readImplementStatus(identifier)` must give a `prUrl` and a `branch`; otherwise `no_pr`.
   The round is chosen, and `git status --porcelain` plus `HEAD` are snapshotted.
   A dirty worktree here is `worktree_dirty` before anything launches.
2. **Launch.** `launch()` with `--model <picked>`, `--plugin-dir <Marshall repo>/plugin`, the prompt `/marshall:handoff <planPath> <ISSUE-ID>`, and six env vars (below).
   No status file: the Stop guard must not hold a writer that has nothing to report.
3. **Wait.** The waiter resolves on the run's terminal hook event.
   After `config.handoffMinutes` (10) with no `Stop`, the run is killed and the result is `timeout`.
4. **Verify the worktree.** The snapshot is taken again.
   Any uncommitted file or a moved `HEAD` is `worktree_dirty`, and nothing is posted.
5. **Validate.** `checkHandoffFile(path, { prUrl, branch })` (rules below).
6. **Resume once.** If the file is invalid, the same session is resumed with one prompt: `The hand-off at <path> failed validation: <problems>. Fix that file in place. Write nothing else, then stop.`
   The wait is what is left of the clock, at least 2 minutes.
   Still invalid → `handoff_invalid` with every problem in `detail`.
   A run with no session id cannot be resumed and fails the same way.
7. **Post.** `postHandoff` (below). A failure there is `post_failed` with the inner reason.

## The env the writer gets

| Var | Value |
|---|---|
| `MARSHALL_ISSUE_DIR` | `~/.marshall/issues/<ID>/` — holds `implement.json`; scratch goes here |
| `MARSHALL_ISSUE_URL` | the Linear issue URL |
| `MARSHALL_HANDOFF_PATH` | `~/.marshall/handoffs/<ID>.md` — the one file the skill writes |
| `MARSHALL_ROUND` | `1`, or the bounce count + 1 |
| `MARSHALL_BASE_BRANCH` | `config.baseBranch`, for `git merge-base` |
| `MARSHALL_PR_URL` | from `implement.json`, for `gh pr view` |

`handoffEnv()` in `src/handoff/phase.ts` builds it; `tests/plugin.test.ts` checks the skill names every key.

## The skill

`plugin/skills/handoff/SKILL.md`, invoked as `/marshall:handoff <plan-path> <ISSUE-ID>`, `disable-model-invocation: true`.
It reads the plan's orientation sections, pins the diff with `git merge-base origin/<base> HEAD`, reads the files that changed, reads `implement.json`, and writes the package from `plugin/skills/handoff/template.md` through a temp file and a `mv`.
It is read-only in the worktree: no edits, commits, checkouts, formatters, tests, or app start; `git fetch origin --quiet` is the one allowed write.
It ends with `HANDOFF_WRITTEN <path> round <N>` or `HANDOFF_BLOCKED <reason>`.
The template is in the plugin, not under `docs/`, because the agent runs in the target repo and cannot read Marshall's tree; [`handoff_template.md`](handoff_template.md) is the human-facing copy.

## Validation rules

`checkHandoffText(text, expected?)` in `src/handoff/validate.ts`; `bin/marshall handoff check <file>` runs it by hand.

- The six H2 sections, in order: `TLDR` (a `**TLDR:**` paragraph under the H1 also counts), `Where to find it`, `Orientation`, `What was wrong and why`, `What the agent did`, `Verification recipe`.
  Heading case and trailing punctuation do not matter.
- An optional `## Round N — what changed` may appear, and only before `Where to find it`.
- `What the agent did` must contain the bold labels `**Review notes (not fixed)**` and `**Follow-ups proposed**` (each may say `(none)`).
- `Verification recipe` must contain a GitHub PR URL and a `- Branch:` line; when `expected` is given they must match `implement.json`.

Every failure is one line in `problems`; the resume prompt and the CLI print them.

## Posting

`postHandoff` in `src/handoff/post.ts`, in this order:

1. Validate the file (with the expected PR URL); invalid → `invalid`, nothing sent.
2. Render: drop the H1 and the `Last edited` stamp; with a `badge`, add `_<badge>_` right under the TLDR.
3. Linear: `updateComment` when the sidecar has a comment id, else `comment`; both append the Marshall footer.
   Failure → `linear_failed`.
4. **Write the sidecar** `~/.marshall/handoffs/<ID>.json` (`issueId`, `commentId`, `round`, `prUrl`, `postedAt`, `badge?`) before touching the PR, so a `gh` failure never loses the comment id.
5. PR body: `gh pr view <url> --json body` (parsed in TypeScript, never `--jq .body`, which adds a newline), `spliceHandoff`, then `gh pr edit --body-file` only when the body changed.
   Failure → `gh_failed`; unbalanced markers → `markers_unbalanced`.

### The splice

The PR body keeps the package between `<!-- marshall-handoff:start -->` and `<!-- marshall-handoff:end -->`, under a `## Hand-off` heading that stays outside the markers.

| Body state | Result |
|---|---|
| One marker pair | The text between them is replaced; bytes outside are untouched |
| `## Hand-off` with the bare `_Filled in by the hand-off step._` line (PRs from before the skill wrapped it) | The placeholder line becomes `start / text / end` |
| `## Hand-off` with other text | The block goes right under the heading; the text stays below |
| No heading | `## Hand-off` and the block are appended |
| Several pairs | The first is replaced, the rest deleted |
| Unbalanced markers | Refused |

A re-post of the same text is a no-op (`prAction: "unchanged"`), so `gh pr edit` is skipped.
A CRLF body gets CRLF inside the markers, so GitHub's normalisation does not make every re-post a change.

## A recorded run

[`examples/step06_CHE-5/`](examples/step06_CHE-5/README.md) holds the package the writer produced for CHE-5 on 2026-09-20 (56 s, valid on the first try, no resume), the sidecar, and PR #36's body before and after.
A badge re-post edited the same comment and the same section; nothing outside the markers changed.

## Running it by hand

```bash
bun scripts/launch-handoff.ts --cwd <worktree> --plan docs/x_plan.md --issue CB-12          # write only
bun scripts/launch-handoff.ts --cwd <worktree> --plan docs/x_plan.md --issue CB-12 --post   # write + post
bun scripts/launch-handoff.ts --cwd <worktree> --issue CB-12 --post-only --badge "rebased after <PR URL>"
bin/marshall handoff check ~/.marshall/handoffs/CB-12.md
```

`--post` and `--post-only` need `MARSHALL_LINEAR_API_KEY`; without them the issue is not fetched and nothing leaves the laptop.
The writer always runs to its `Stop`; the launcher prints the wall clock at the end.

## Tests

- `bun test tests/handoff/` — validate, render, splice, sidecar, post, and the phase end to end with the fake `claude` and `gh` shims (`tests/fixtures/fake-claude`, `tests/fixtures/fake-gh`).
- `MARSHALL_LIVE=1 MARSHALL_LIVE_HANDOFF_CWD=<worktree> bun test tests/handoff.live.test.ts` — the real writer against a worktree with an open PR (CHE-5 by default), asserting a valid file in under 10 minutes; posts nothing.
