# Step 11 — Innovate Agent

<!-- Last edited: 2026-09-20 10:55 CDT -->

**TLDR:** Give Marshall a way to suggest work, not only do it.
A scheduled agent reads the ChessBuddy repo, writes three feature proposals, and pushes them to my phone.
I say like or pass and add a note.
A liked proposal becomes a Linear issue that merges the agent's draft with my note, and the loop builds it.
This is the last step of iteration 1 and runs only after step 10 proves the loop.

## Goal

`marshall innovate` produces proposals with verified repo anchors, `marshall proposals like <id> --note "..."` turns one into a pickable Linear issue that carries my note, and the next run never re-proposes what I passed.

## Depends on / parallel with

- Depends on: 02 (Linear client, `agent-proposed` label), 03 (runner), 07 (slot and caps), 09 (ntfy push, CLI), and 10 (the loop is proven).
- Parallel with: nothing.
  The skill fork alone can be drafted any time after 01, but do not wire it in before the dry run.

## Spec references

Section 16 of `project_marshall_plan.md`, plus the rows it added to sections 4, 7, 9, 11, 12, 13, and 14.

## In scope

### Skill `skills/marshall-innovate/SKILL.md`

- Fork of `~/.claude/skills/innovate/SKILL.md`, reusing its `LENSES.md` and `TEMPLATE.md` where they fit. Changes:
  - Tiers 1 to 3 only. Exactly one idea per tier by default (`proposalsPerRun` = 3).
  - Every idea carries an **issue draft**: problem, proposed change, acceptance criteria, likely touched files, out of scope.
  - The graveyard comes from the `proposals` table (passed and expired titles with reasons), passed in by the orchestrator, not from a previous run file.
  - Output is one file per proposal in `~/.marshall/proposals/<id>.md` plus a `proposals.json` manifest the orchestrator ingests. No chat hand-over, no "one you would fund."
  - Read-only. The skill must not edit the repo, open a PR, or call any Linear tool.
- Runs in a fresh worktree at `origin/main`, through `runner.launch`, with the `quick` variant by default.

### Proposal store `src/innovate/proposals.ts`

- Migration: `proposals` table with `id`, `kind` (`feature` | `bug`), `title`, `tier`, `pitch`, `anchors` (JSON), `issue_draft`, `file_path`, `status` (`proposed` | `liked` | `filed` | `passed` | `expired`), `note`, `linear_issue_id`, `run_id`, `created_at`, `answered_at`, `filed_at`.
- Lifecycle functions: `ingest(manifest)`, `like(id, note)`, `pass(id, note)`, `expire(olderThanDays)`, `graveyard()`.

### Scheduler hook `src/innovate/schedule.ts`

- Fires on `innovate.schedule` (default weekly) and on `marshall innovate`.
- Skip rules, each with a logged reason: open proposals ≥ `innovate.maxOpen` (6), pickup-ready queue ≥ `innovate.maxBacklog` (5), no free slot, daily or window cap reached.
- A run takes one slot and counts as one start against both caps.

### Spec writer `src/innovate/spec-writer.ts`

- `writeIssue(proposal, note) → {title, description, priority}`.
- With a note: one `claude -p --model opus --output-format json --json-schema <schema>` call. My note wins on conflict, nothing from it is dropped, it appears verbatim under a **Human input** heading, acceptance criteria reflect it.
- Without a note: return the issue draft as-is, no model call.
- Then `linear.createIssue`: Todo, assigned to me, label `agent-proposed`, priority from the note if named, else No priority. Description ends with a Background section and `Origin: Marshall proposal <id>`.

### CLI `bin/marshall`

- `innovate [focus] [--quick|--full]`.
- `proposals`, `proposals show <id>`, `proposals like <id> [--note]`, `proposals pass <id> [--note]`.
- `status` gains an "open proposals" count and the last run's skip reason, if any.

### Linear setup

- `marshall linear setup` creates the `agent-proposed` team label. Idempotent like the rest.

### Notifications

- `proposals_ready` push, one per run: id, tier, title per proposal.
- `proposal_filed` badge only.

### Config

`innovate: { enabled, schedule, quick, proposalsPerRun, maxOpen, maxBacklog, expireDays }` in `marshall.config.json`, with the defaults above and `expireDays` = 14.

## Out of scope

- Dashboard card and any remote reply channel. Iteration 2 (Tailscale dashboard) and 4 (Telegram).
- Tier 4 and 5 ideas. Run `/innovate` by hand for those.
- The Testing agent. Only the `kind` column is reserved for it.
- Letting the agent file issues itself. The orchestrator files, after a human yes.

## Reuse (search first)

- `~/.claude/skills/innovate/` — SKILL.md, LENSES.md, TEMPLATE.md. The base.
- `src/runner/` — launch, hooks, stop. Same path as the planner.
- `src/linear/` — `createFollowUp` is the template for `createIssue`; the label setup is the template for `agent-proposed`.
- `src/classify.ts` (step 04) — the `claude -p ... --json-schema` pattern the spec writer reuses.
- `src/notify.ts` (step 09) — add the two events to the mapping.
- Step 07's queue query — the backlog count for the skip rule.

## Deliverables

- `skills/marshall-innovate/SKILL.md` and the install note or symlink.
- `src/innovate/proposals.ts`, `schedule.ts`, `spec-writer.ts`, the migration, each under 500 lines.
- `bin/marshall innovate` and `bin/marshall proposals ...`.
- `tests/innovate/*.test.ts`: lifecycle and graveyard, skip rules with a fake clock and queue, spec writer with the model call mocked (note present, note absent, note conflicts with draft), manifest ingest, and a transcript check that the skill made no write calls.
- `docs/innovate.md` — how it runs, how to reply, how a proposal becomes an issue, config keys.
- A recorded run on ChessBuddy: three proposal files checked in under `docs/examples/proposals/`, and one of them liked with a note, with the resulting Linear issue text pasted in.

## Acceptance criteria

- `marshall innovate --quick` on ChessBuddy yields 3 proposals, one per tier 1–3, each with at least two anchors that a check script confirms exist, one `proposals_ready` push arrives on the phone, and `marshall proposals` lists them.
- `marshall proposals like <id> --note "..."` creates exactly one Linear issue in Todo, assigned to me, label `agent-proposed`, with the note verbatim under **Human input** and acceptance criteria that reflect it. The next poll tick claims it like any other issue.
- `marshall proposals like <id>` with no note files the draft unchanged and makes no model call.
- `marshall proposals pass <id> --note "..."` puts the title and reason into the next run's prompt, and that run does not re-propose it.
- Each skip rule fires with a logged reason and no agent launch.
- The Innovate agent's transcript contains no file edits outside `~/.marshall/proposals/`, no git push, and no Linear write.
- A run appears as one start in the daily and window cap counts.

## Open questions for grilling

1. **Proposal store.** Keep proposals in Marshall's SQLite until I say yes (this file), or file them straight into Linear Triage and reply by comment + move to Todo? The second gives phone replies for free but shows unreviewed ideas in Linear.
2. **Phone replies now or later.** CLI only in iteration 1, or an ntfy reply topic? The note lands in an issue a full-permission agent runs, so an ntfy topic needs a reserved topic or a shared secret.
3. **Cadence and budget.** Weekly `quick` by default? Should a run really count against the 6/day and 2-per-5h caps, or run outside them at night?
4. **Push shape.** One digest push per run, or one push per proposal so I can act on each from the notification?
5. **Tier ceiling.** Stop at tier 3, or allow a tier 4 as a time-boxed "spike" issue?
6. **Spec writer without a note.** Skip the model call (this file), or always run it to tighten acceptance criteria?
7. **Priority.** No priority by default so step 07 sorts it last, or Medium so it competes with my own issues?
8. **Expiry.** 14 days, then graveyard. Should an expired proposal be allowed back after 90 days if the run can say what changed?
