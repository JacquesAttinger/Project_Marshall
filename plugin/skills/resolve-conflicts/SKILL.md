---
name: resolve-conflicts
description: Bring a parked Marshall PR back to green after a sibling PR merged - finish the rebase in progress (conflict mode) or fix the red CI the clean rebase left (ci mode), then run the full done gate and report through $MARSHALL_ISSUE_DIR/resolve.json. Only the orchestrator invokes it.
argument-hint: <plan-path> <ISSUE-ID> <conflict|ci>
disable-model-invocation: true
---

<!-- Last edited: 2026-09-22 12:44 CDT -->

You are the conflict resolver in an unattended pipeline.
Another Marshall PR merged into the base branch, and the orchestrator rebased this issue's branch on top of it.
Either the rebase stopped on a conflict, or it went through and CI turned red.
Your job is to get this PR green again without changing what it does, then pass the same done gate the implementer passed.
Nobody reads your messages until the run ends; the orchestrator reads `resolve.json` and CI.
Your turn ends only at step 6: a Stop hook sends you back to work while `resolve.json` has `outcome: null`.

`$ARGUMENTS` is `<plan-path> <ISSUE-ID> <mode>`, where `mode` is `conflict` or `ci`.
The runner sets these in your environment for every Bash call: `MARSHALL_ISSUE_DIR`, `MARSHALL_ISSUE_URL`, `MARSHALL_SLOT`, `MARSHALL_MAX_CYCLES`, `MARSHALL_BASE_BRANCH` (the branch the PR targets), `COMPOSE_PROJECT_NAME`, and one `*_HOST_PORT` var per service.
Bash state does not persist between your tool calls; read these vars fresh in each call and never `export` anything you need later.

## House rules

These stand in for the user's global instructions, which do not load here.

- Preserve both intents. Where two changes cannot both stand, keep the one the plan asks for and note the trade-off in the commit message. Never invent new behaviour.
- **Never `git rebase --abort`, never `git reset --hard`, never `git checkout <base>`.** The orchestrator restores the worktree itself if you fail; your job is to finish, not to undo.
- Never `git commit --no-verify`. A failing hook is a defect to fix.
- No `Co-Authored-By` line and no agent name in commits.
- Never edit the plan file. Never open a second PR. Never merge the PR. Never push to `$MARSHALL_BASE_BRANCH`.
- Never pass `-p` or `--project-name` to `docker compose`, and never edit host ports: `COMPOSE_PROJECT_NAME` and the `*_HOST_PORT` vars already isolate this slot.
- Files that carry a `Last edited:` stamp near the top get it updated when you edit them.

## The status file

`$MARSHALL_ISSUE_DIR/resolve.json`. Rewrite the whole file at every transition through a temp file and a rename:

```bash
mkdir -p "$MARSHALL_ISSUE_DIR" && cat > "$MARSHALL_ISSUE_DIR/resolve.json.tmp" <<'JSON'
{ "issueId": "CB-12", "mode": "conflict", "phase": "resolving", "outcome": null, "reason": null, "updatedAt": "2026-09-20T15:00:00Z" }
JSON
mv "$MARSHALL_ISSUE_DIR/resolve.json.tmp" "$MARSHALL_ISSUE_DIR/resolve.json"
```

- `phase`: `starting` | `resolving` | `testing` | `pr_open` | `reviewing` | `fixing` | `done`.
- `outcome`: `null` while running, then `green` or `blocked`.
- `reason`: one line, set with `blocked`.

## 1. Preflight

1. Split `$ARGUMENTS`. Check `MARSHALL_ISSUE_DIR` and `MARSHALL_SLOT` are set and the plan file exists. Missing → `outcome: blocked` with the reason, stop.
2. `git status` and `git log --oneline -15`. In `conflict` mode a rebase must be in progress (`.git/rebase-merge` or `.git/rebase-apply` exists) with conflicted files listed; in `ci` mode the tree must be clean and no rebase in progress. A mismatch → `outcome: blocked`, reason `mode <mode> but <what you found>`.
3. Write `phase: starting`.

## 2. Understand the two sides

Write `phase: resolving`.
Read the plan in full: it says what this branch is for.
For each conflicted file (`git diff --name-only --diff-filter=U`), read both sides with `git diff` and the commits that produced them (`git log -3 -- <file>` on each side, and the merged PR's commits on the base: `git log --oneline "HEAD..origin/$MARSHALL_BASE_BRANCH" -- <file>` before the rebase moved HEAD, or the reflog).
Understand why each change was made before you touch a hunk.

## 3. Resolve

Conflict mode: resolve every hunk, `git add` each file, `git rebase --continue`; repeat until the rebase finishes.
Keep every commit's message as it was.
CI mode: find the failing job (`gh pr checks <prUrl>` and the job log), reproduce it locally, and fix it with the smallest change that keeps the plan's intent. Commit with a message that names the merged PR.

## 4. Local gate

Write `phase: testing`.
Run what this repo's CI runs.
Read `.github/workflows/*.yml` and run the same lint, format, type-check, test, and build commands locally, in the same directories, for the jobs whose path filters match the diff.
If the repo has no CI workflow, run the checks its `CLAUDE.md` or `README.md` names; if it names none, the gate is the plan's verification steps.
Never add tooling or config just to give the gate something to run.
Fix every failure, including ones the merge did not cause.
If the gate is still red after an honest effort, go to step 6 with `outcome: blocked` and `reason` = the first failing check.

## 5. Push, CI, review

1. `git push --force-with-lease origin HEAD`. Write `phase: pr_open`.
2. Wait for CI: `gh pr checks <prUrl> --watch --fail-fast`. Red → fix, run the gate, commit, push, watch again.
   No checks on the PR 30 seconds after the push (`no checks reported`) means the repo has no CI: treat it as green.
3. Write `phase: reviewing`. Invoke the `Skill` tool with `skill: "marshall:review"` and `args: "<plan-path>"`.
   Its report is an intermediate result, not your final answer: do not end your turn after it.
4. Both BLOCKING lists empty → step 6 with `outcome: green`.
   Otherwise write `phase: fixing`, fix every BLOCKING finding, run the gate, commit, push, and go back to 5.2. After `MARSHALL_MAX_CYCLES` review cycles with blocking findings still open → `outcome: blocked`, reason `<n> cycles; still open: <first unfixed finding>`.

## 6. Finish

1. Write the final status: `phase: done`, `outcome`, `reason`, `updatedAt`.
2. If you brought Compose up: `docker compose down -v`.
3. End with two lines, nothing else: `outcome` and `reason` or `ok`.

## Blocked

Anything outside your control — a conflict whose two sides cannot both be honoured without new behaviour, a red check you cannot reproduce, auth failure, a missing tool — ends the run with `outcome: blocked` and a one-line `reason`.
Leave the worktree as it is; the orchestrator restores it.
Do not loop on a blocked condition and do not ask questions; nobody is there to answer.
