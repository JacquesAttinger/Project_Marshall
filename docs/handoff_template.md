# Hand-off template — what each section is for

<!-- Last edited: 2026-09-20 17:30 CDT -->

**TLDR:** The hand-off is a fixed six-section note the writer agent leaves for you after an issue's PR is green.
Read it top to bottom and you can decide "merge as-is" or "test by hand" without opening the diff cold.
The copy the agent works from is [`plugin/skills/handoff/template.md`](../plugin/skills/handoff/template.md); this page explains it.

## Shape

Line 1 is `# <ISSUE-ID> — <issue title>`, line 3 a `<!-- Last edited: … -->` stamp, then a `**TLDR:**` paragraph, then five H2 sections in this order.
`bin/marshall handoff check <file>` enforces the order, the two bold sub-lists in section 5, and the PR URL and branch line in section 6.
The posted copies (Linear comment, PR body) drop the H1 and the stamp; nothing else changes.

## 1. TLDR

One or two sentences a 15-year-old can follow: what was wrong, what changed, and how to see it.
A `**TLDR:**` paragraph under the H1 counts; a `## TLDR` heading is accepted too.

## Round N — what changed (bounces only)

When a human bounced the issue and the agent went around again, the whole package is rewritten and this H2 sits right after the TLDR: two to five lines on what the bounce asked for and what changed since the last round.
A reader of round 3 must not need rounds 1 and 2.
It is optional and never counts as a seventh required section; it may only appear before "Where to find it".

## 2. Where to find it

Click-by-click from the app's start page: page, menu or tab names, filters or states needed to reveal the feature.
Not UI-reachable → say so, name what it is (a job, a script, an endpoint), and give the exact command or URL.
The acceptance test for the whole package: a reader who has never opened the repo can find the feature from this section alone.

## 3. Orientation

Area → part → section, each with one line on what it does.
Area: the part of the codebase the change touches and its job.
Part: the module or file where the change lives.
Section: the exact function or block that changed.

## 4. What was wrong and why

The bug or the gap, and the cause as read from the code before the change.
Past tense: the fix has landed.

## 5. What the agent did

The fix in prose (two to five sentences), then four bold sub-lists in this order:

- **Files that matter** — one line per file: what changed and why. Generated files, lockfiles, and snapshots collapse to one line. The PR carries the exhaustive diff.
- **Decisions made alone** — every call a human would normally be asked about, from the plan plus any made while implementing.
- **Review notes (not fixed)** — the `reviewNotes` lines from `implement.json`, verbatim (the review's PLAUSIBLE findings left as-is), or `(none)`.
- **Follow-ups proposed** — the `followups` titles from `implement.json`, or `(none)`. The issues are filed after the hand-off, so only titles appear here.

## 6. Verification recipe

```markdown
- Branch: `<branch-name>`
- PR: https://github.com/<owner>/<repo>/pull/<n>
- Setup: what to bring up or seed first, or `none`.
- Steps:
  1. One action per line, in order.
- Expected:
  - PASS when step 1 …
```

The branch and the PR URL must match `implement.json`; the check refuses a mismatch.
One `PASS when …` line per step, so a manual tester has a checklist.

## What is never in it

No screenshots and no logs: tests and review already ran, and CI is on the PR.
No Linear or PR edits by the writer; Marshall posts the file after the check.
No badge in the file: the `_rebased after <PR>_` line under the TLDR is added at post time and recorded in the sidecar `~/.marshall/handoffs/<ID>.json`.
