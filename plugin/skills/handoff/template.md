# <ISSUE-ID> — <Issue title>

<!-- Last edited: YYYY-MM-DD HH:MM TZ -->

**TLDR:** One or two sentences a 15-year-old can follow: what was wrong, what changed, and how to see it.

## Where to find it

Click-by-click navigation to the affected feature (starting page, menu or tab names, filters or states needed to reveal it).
If it is not reachable through the UI, say "Not UI-reachable" and name what it is instead (a job, a script, an endpoint) and how to call it.

## Orientation

Area → part → section.
Name the area of the codebase the change touches and what that area does.
Narrow to the part where the change lives and what that part does.
Narrow again to the exact section that changed and what that section does.

## What was wrong and why

The bug or the gap, and the cause as read from the code before the change.

## What the agent did

The fix in prose: two to five sentences on the shape of the change.

**Files that matter**

- `path/to/file` — what changed and why. Generated files collapse to one line.

**Decisions made alone**

- Every call a human would normally be asked about: the choice and the reason. Copy from the plan, then add any made during implementation.

**Review notes (not fixed)**

- Verbatim `reviewNotes` lines from `implement.json`, or `(none)`.

**Follow-ups proposed**

- Follow-up titles from `implement.json`, or `(none)`.

## Verification recipe

- Branch: `<branch-name>`
- PR: https://github.com/<owner>/<repo>/pull/<n>
- Setup: what to bring up or seed first, or `none`.
- Steps:
  1. One action per line, in order.
  2. …
- Expected:
  - PASS when step 1 …
  - PASS when step 2 …
