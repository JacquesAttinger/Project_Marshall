---
name: review
description: Review the current branch's diff against origin/main on two axes - the built-in /code-review bug hunt (CONFIRMED / PLAUSIBLE) and a Spec pass against the plan file. Reports BLOCKING (confirmed), BLOCKING (spec), and NOTES (plausible). Use from /marshall:implement after each push, or by hand on a finished branch.
argument-hint: <plan-path>
---

<!-- Last edited: 2026-09-20 11:10 CDT -->

Review the diff between `origin/main` and `HEAD` on two axes and report three lists.
`/marshall:implement` fixes the two BLOCKING lists and carries NOTES into the hand-off.
`$ARGUMENTS` is the plan file path, relative to the repo root.

## 1. Pin the diff

```bash
git fetch origin --quiet
base=$(git merge-base origin/main HEAD)
git log --oneline "$base"..HEAD
git diff --stat "$base"...HEAD
```

Stop with `REVIEW SKIPPED: empty diff` if the diff is empty.
Stop with `REVIEW SKIPPED: plan file missing <path>` if `$ARGUMENTS` does not name a readable file.
Both cases are the caller's problem, not a finding.

## 2. Bug hunt (built-in `/code-review`)

Invoke the `Skill` tool with `skill: "code-review"` and `args: "high origin/main...HEAD"`.
It reads every hunk, verifies each candidate, and reports findings with a verdict of `CONFIRMED` or `PLAUSIBLE`.
Do not pass `--fix`; the caller decides what to fix.
Collect every finding as `file:line - summary (verdict)`.
Uncommitted changes are in scope too; the caller commits before it calls this skill, so a working-tree finding means a forgotten commit.

## 3. Spec pass (one sub-agent)

Spawn one `general-purpose` agent with this brief, filled in.
The sub-agent cannot see this file or the caller's context, so the brief carries everything.

> You are reviewing a branch against the plan that asked for it.
> Run `git diff <base>...HEAD` and `git log --oneline <base>..HEAD` in `<cwd>` (base = `<merge-base sha>`).
> The spec is the file `<plan-path>`. Read it in full. Its "Out of scope" and "Out of scope found" sections list work the branch must not do.
>
> Report, quoting the plan line for each finding:
> (a) requirements the plan asked for that are missing or partial;
> (b) behaviour in the diff that the plan did not ask for (scope creep), except tests, comments, and the `Last edited` stamps;
> (c) requirements that look implemented but where the implementation looks wrong, with the file and line.
>
> Number each finding. State `NONE` under a heading that has no findings. Under 400 words. Do not edit any file.

## 4. Report

Print exactly these three headings, each followed by a numbered list or `NONE`:

```
## BLOCKING (confirmed)
<CONFIRMED findings from step 2, file:line - summary>

## BLOCKING (spec)
<findings (a) and (c) from step 3, plus (b) when the extra behaviour changes runtime code>

## NOTES (plausible)
<PLAUSIBLE findings from step 2, one line each, and (b) findings that are docs or tests only>
```

End with one line: `REVIEW: <n> confirmed, <n> spec, <n> notes`.
Do not rerank across lists and do not fix anything.
