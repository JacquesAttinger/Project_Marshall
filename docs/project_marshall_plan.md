# Project Marshall — Planning Spec (v3)

<!-- Last edited: 2026-09-21 14:55 CDT -->

## TLDR

Project Marshall is a robot manager for my coding robots.
It watches my Linear to-do list, picks up open issues, and starts Claude agents that plan and build the fix.
I do not sit at the keyboard.
I watch a dashboard, get a push notification when a robot is done or stuck, and then decide if I need to test it by hand.
Iteration 1 runs on my laptop, watches the ChessBuddy Linear workspace, and runs at most 2 agents at a time.
Later, I talk to Marshall from my phone and it turns my words into issues and agents.
This is v3 of the spec.
All 25 open questions from v1 are answered in section 15.
v3 adds the Innovate agent (section 16, build step 11).
It reads the repo, proposes new features, and asks me.
When I say yes, it writes a Linear issue from its idea plus my notes, and the normal loop builds it.

---

## 1. Vision

I want to move from "I drive Claude" to "I supervise Claude."
Today I find a Linear issue, run `/linear-plan`, answer questions, and ship.
Tomorrow, a master agent finds the issue, plans it, builds it, opens a PR, and tells me what it did and how to check it.
The end state is a Marshall-style assistant.
I give it an open-ended goal by voice, and it splits the goal into Linear issues and runs the same loop.
Marshall should also propose work, not only execute it.
The Innovate agent (section 16) is the first piece of that.

## 2. Scope

### 2.1 Iteration 1 — the Linear autopilot

- A daemon runs on my laptop and watches the **ChessBuddy** Linear workspace (team ChessBuddy) for pickup-ready issues.
- The only repo it works in is `~/code/ChessBuddy`.
- It runs at most **2** master agents at the same time. Raise to 3 after the loop proves itself.
- Each master agent owns one issue from pickup to "Needs Verification."
- A dashboard shows every master agent, its phase, the queue, and a hand-off card for anything that needs me.
- I get a push notification when an agent finishes, is blocked, or the queue pauses for rate limits.
- Agents file out-of-scope work as new Linear issues.
- **After the dry run proves the loop:** an Innovate agent scans the repo on a schedule, proposes new features, and pushes them to me.
  I like or pass each one, with a note.
  A liked proposal becomes a Linear issue that merges the agent's draft with my note, and the loop picks it up (section 16, step 11).

### 2.2 North star — Marshall

- I speak to Marshall from my phone or Mac.
- Marshall turns speech into a Linear issue.
- Marshall takes open-ended goals ("build a first draft of this web app"), splits them into Linear issues, and runs the same loop.
- Marshall runs on an always-on machine, not my laptop.

### 2.3 Out of scope for iteration 1

- Voice input.
- Open-ended goal decomposition.
- The Hemut workspace. Hemut comes only after ChessBuddy proves the loop.
- Dedicated hardware or cloud hosting.
- Agents that ask me design questions mid-plan.
- A Testing agent that finds bugs and proposes fixes. It reuses the Innovate agent's proposal loop later (section 16.8).

## 3. Operating principles

1. **Fast iteration over perfect plans.** Agents do not ask me questions while they plan. They make a call and ship a first draft.
2. **I verify, I do not steer.** My job is to read the hand-off, decide if a manual test is needed, and merge or bounce.
3. **Linear is the state machine.** Every lifecycle change is a Linear state change. The orchestrator keeps only a small local claim table for crash recovery.
4. **Follow-ups are issues.** Anything an agent finds out of scope becomes a Linear issue that the loop picks up later.
5. **Hard cap of 2 master agents, global.** Budget and rate limits, not ambition, set this number.
6. **Push, do not poll.** I get a notification when an agent needs me. I do not watch the terminal.
7. **Marshall runs while I work.** It does not pause when I am on the laptop. I do LeetCode while Marshall does my tickets.

## 4. Components

| Component | Role | Decision |
|---|---|---|
| **Scheduler / queue** | Polls Linear, orders issues, enforces cap and cadence | launchd job + SQLite claims table |
| **Master agent** | One per issue. Owns the lifecycle. Dispatches planner and implementer. | Orchestrator process that launches `claude --bg --name <issue-id>` |
| **Complexity classifier** | Picks Opus vs Fable for planning | Haiku, reads the issue title, body, priority, labels |
| **Planner** | Reads the issue and the repo, writes a plan file, no human interview | Autonomous fork of `linear-plan`, run in plan mode |
| **Implementer** | Runs the plan in a worktree, tests, lints, opens a PR, polls CI | `ship-plan` skill, Opus |
| **Reviewer** | Second Claude pass over the diff before hand-off | `code-review` skill (`ship-plan` has no reviewer of its own) |
| **Follow-up filer** | Files out-of-scope findings as Linear issues | Linear MCP `save_issue`, label `agent-filed`, relation `related` |
| **Hand-off writer** | Produces the orientation + recipe package | Written to a file, posted to Linear and the PR, shown on the dashboard |
| **Dashboard** | Panels, queue, hand-off cards, kill button | Small local web app, reached over Tailscale; `claude agents` TUI until it exists |
| **Notifier** | Push to iPhone and Mac | ntfy.sh, one topic per master agent + one for the orchestrator |
| **Voice intake** | Speech → Linear issue | Deferred (iteration 3) |
| **Innovate agent** | Reads the repo, proposes features, writes an issue draft per idea. Files an issue only after I say yes. | Fork of `/innovate` as `marshall-innovate`, run through the same runner; `proposals` table; step 11 (section 16) |

## 5. Issue lifecycle

### 5.1 Linear states

| Linear state | Meaning | Who moves it |
|---|---|---|
| Todo, assigned to me | Pickup-ready. No opt-in label. | Me |
| In Progress | A master agent claimed it | Master agent, atomic update |
| Needs Verification (custom state, type `started`) | PR is open, CI is green, review passed, hand-off is posted | Master agent |
| Done | I merged the PR | Linear GitHub automation on merge |
| Todo again, with a comment | I bounced it. The comment is the new instruction. | Me |

Bounce rule: the same issue may bounce back to Todo at most 3 times.
On the 4th bounce the orchestrator marks it Blocked and notifies me.
A bounced issue resumes its existing branch and plan; it does not start over.

### 5.2 Internal claim states

`Unclaimed → Claimed → Planning → Implementing → Reviewing → PR Open → Awaiting Human → Released`

Failure paths: `Blocked` (agent gave up), `Stalled` (no tool call for 15 minutes), `Over Budget`, `Rate Limited`.
`Blocked` and `Over Budget` push a notification.
`Rate Limited` pauses the whole queue and pushes once.

### 5.3 Pickup contract

1. Poll Linear every 30–60 s for issues in state type `unstarted`, assigned to me, in the ChessBuddy team.
2. Order by Linear priority, then created date.
3. Skip an issue if the daily cap (6 starts) or the window cap (2 starts per rolling 5 hours) is reached.
4. Pre-read the issue; skip it if it is no longer `unstarted` or already carries a `marshall/agent-*` label. Then one `issueUpdate`: move to In Progress, add label `marshall/agent-<slot>`, remove the other agent labels. (`delegate` only accepts agent users, so it waits for the iteration 2 OAuth agent.)
5. Re-read the issue. If it is not In Progress with our label as the only agent label, abort.
6. Insert into the local SQLite claims table (unique constraint on issue ID).

### 5.4 Conflict resolution after merge

There is no overlap check at pickup (decided 2026-09-20, step 04 grilling).
Two agents may touch the same code; the cost is a rebase later, and a guess from the issue text was never going to be reliable.
When a Marshall PR merges, every other open Marshall PR is rebased on `origin/main` in its worktree.
A clean rebase with green CI re-posts the hand-off with a badge.
A conflict or red CI launches a resolver agent (`/marshall:resolve-conflicts`), then the full done gate, then a re-posted hand-off and a push notification.
Details in step 08.

## 6. Master agent behavior

### 6.1 Model routing

- A Haiku classifier reads the issue (title, description, priority, labels, comment count; no repo access) and returns `simple` or `complex`.
- Planner: Opus for `simple`, Fable for `complex`. Complexity only; priority is an input to the classifier, not an override. Models come from `config.models`.
- Implementer: Opus always.

### 6.2 Plan phase

- The orchestrator fetches the issue, writes a brief file, and launches `/marshall:plan <brief>` from the `marshall` plugin in the worktree. The agent has no Linear access (`--strict-mcp-config`).
- The agent runs an autonomous variant of `linear-plan`: same orientation walkthrough, no `/grilling`, no interview, every open call recorded under "Decisions made alone".
- The plan is committed on the issue branch as `docs/<topic>_plan.md`, one commit. The orchestrator verifies with git that nothing else changed and that the required sections are present.
- The orchestrator posts the plan's TLDR and decisions as one comment on the Linear issue.
- A bounce runs the planner again in revise mode: it updates the plan and appends `## Revision N` before implementation resumes.
- Clock: `planMinutes` (20) inside the 2-hour issue clock. Built in step 04; see `planning.md`.

### 6.3 Implement phase

- Run `ship-plan` in a fresh worktree cut from `origin/main`.
- Copy `.env` as `ship-plan` already does. Real credentials, no reduced-scope copy.
- Give each agent its own Docker Compose project name and port offset so two agents never share a database or a port.
- Poll CI. Up to **4** implement → review → fix cycles, then mark `Blocked`.

### 6.4 Done gate

An agent may not hand off until all of these are true:

- Tests pass locally.
- Lint passes.
- CI is green on the PR.
- A second Claude pass (`code-review` skill) approved the diff.
- The hand-off package (section 7.1) is written and posted.

Research shows about half of failing agent runs self-report success without an independent check.
The done gate is the single most important part of this spec.

### 6.5 Out-of-scope filing

- Create a Linear issue in the ChessBuddy team.
- Add label `agent-filed`. Add relation `related` back to the origin issue.
- No depth cap. Agent-filed issues are pickable immediately, like any other Todo. The daily cap and cadence are the brake.

### 6.6 Limits and recovery

- Wall clock: **2 hours** per issue for planning plus implementation. Then stop and notify.
- Stall: no tool call for 15 minutes → `Stalled`.
- Resume: a stalled or interrupted agent resumes its session, branch, and plan. Up to 2 resumes.
- After 2 resumes: discard the branch, start fresh once. If that fails too, mark `Blocked` and notify.
- Reconcile on boot: compare the claims table with Linear. Release any claim with no live agent process.
- Permissions: agents run with full permissions. See section 14.

## 7. Human intervention points

| Trigger | What I see | What I do |
|---|---|---|
| Needs Verification | Push + hand-off card | Read the hand-off. Merge as-is, test by hand, or bounce with a comment. |
| Blocked | Push + reason | Fix the blocker, or cancel the issue |
| Over Budget | Push + cost so far | Raise the cap or cancel |
| Rate Limited | One push on pause, one on resume | Nothing |
| Crashed | Push | Restart the daemon |
| Queue empty | Dashboard badge only | Add issues |
| Proposals ready | One push per Innovate run with the titles; `marshall proposals` for the detail | Like with a note, pass with a reason, or ignore (expires after 14 days). See section 16. |

Agents never ask me design questions mid-plan.

### 7.1 The hand-off package

The point of the hand-off is that I understand what the agent did and why before I approve it.
It follows the `linear-plan` orientation format.
It is posted in three places: a Linear comment, the PR body, and the dashboard card.

1. **TLDR** — one or two lines.
2. **Where to find it** — click-by-click UI path, or "not UI-reachable" for backend work.
3. **Orientation** — the app area, then the specific part, then the exact section, each with what it does.
4. **What was wrong and why.**
5. **What the agent did** — the fix, files touched, any decisions it made on its own.
6. **Verification recipe** — branch, PR URL, setup or seed steps, steps to run, expected result.

The agent does not attach screenshots or logs.
It has already run the tests and the review.
The hand-off gives me enough to decide "merge as-is" or "test by hand."

## 8. Dashboard spec

### 8.1 Panels (max 2, one per master agent)

- Issue ID and title, linked to Linear.
- Phase: Planning / Implementing / Reviewing / PR Open / Awaiting Human / Blocked.
- Model in use.
- Elapsed time and tokens so far.
- Last action (one line).
- A "needs you" flag.
- A **Kill** button. This is the only action in v1.

### 8.2 Queue

- The next N pickup-ready issues in priority order.
- Which ones are waiting on the daily cap or the window cap.

### 8.3 "Needs you" list

- Every issue in Needs Verification or Blocked.
- Each card shows the full hand-off package or the block reason.
- Iteration 2: every open proposal, with Like and Pass buttons and a note box (section 16.5).

### 8.4 Access and data

- Small web app on the laptop, reached from Mac and phone over Tailscale.
- Read-only except Kill. Approve, reject, and reorder happen in GitHub and Linear.
- Iteration 2 adds one more write: replying to a proposal (Like / Pass + note).
- Data sources: the orchestrator SQLite DB, `~/.claude/jobs/*/state.json` from `claude --bg`, and the hand-off files.
- Until the web app exists, `claude agents` in a terminal is the stand-in.

## 9. Notifications

- Channel: ntfy.sh. One topic per master agent, one for the orchestrator.
- Push: finished (Needs Verification), blocked, over budget, crashed, rate-limit pause, rate-limit resume, proposals ready (one per Innovate run).
- Badge only: queue empty, phase changes, proposal filed.

## 10. Infrastructure

### 10.1 Iteration 1 — laptop

- Laptop sits on a desk, plugged in, lid open. `caffeinate -i` keeps it awake.
- The orchestrator runs as a launchd job. Templates exist in `~/Library/LaunchAgents/com.jacques.*`.
- Agents launch with `claude --bg --name <issue-id>`. The Claude daemon supervises them, keeps a roster, and restarts them after a reboot.
- HTTP hooks (`Stop`, `SessionEnd`, `Notification`) post to the orchestrator so it learns about completion without polling.
- Marshall keeps running while I use the laptop.

### 10.2 Auth and budget — staying on Max

- Everything uses the Max login. No API key. This rules out the Agent SDK and `claude -p --bare`.
- **Reactive pause.** When a session exits with a rate-limit error, the queue pauses, claims are kept, and the queue resumes after the 5-hour window rolls over.
- **Daily cap:** 6 issue starts per day.
- **Cadence:** at most 2 issue starts per rolling 5-hour window.
- **Concurrency:** 2 master agents.
- Max limits assume ordinary individual use. An always-on orchestrator is a gray zone. The caps above are what keeps it inside the pool.

### 10.3 Later — always-on machine (decide later)

- Option A: headless Mac mini with `claude setup-token` (one-year OAuth token on Max). Loses Remote Control and claude.ai connectors.
- Option B: Linux VPS with an API key. Cleanest billing and no Keychain problems, but leaves Max.
- Option C: Claude Code Routines (cloud, Linear connector, API trigger). Zero hosting, but 1-hour minimum cadence, daily run cap, research preview, no custom dashboard.

## 11. Reuse from the existing harness

| Piece | Path | How Marshall uses it |
|---|---|---|
| `linear-plan` | `~/.claude/skills/linear-plan/` | Forked into `skills/plan/` of the `marshall` plugin as the autonomous no-interview variant; its orientation format is the hand-off format |
| `ship-plan` | `~/.claude/skills/ship-plan/` | The implementer step: worktree off `origin/main`, `.env` copy, tests, lint, rebase, PR, CI poll |
| `code-review` | `~/.claude/skills/code-review/` | The second Claude pass in the done gate |
| `linear-sync` | `~/.claude/skills/linear-sync/` | PR → Linear state sync (needs un-scoping from Hemut) |
| `triage` | `~/.claude/skills/triage/` | AGENT-BRIEF was the model for the planner brief file |
| `session-start-linear-suggest.sh` | `~/.claude/hooks/` | The queue poll query |
| `claude --bg` + supervisor daemon | built in | Background sessions with readable job state |
| launchd templates | `~/Library/LaunchAgents/com.jacques.*` | Always-on scheduler on the laptop |
| HTTP hooks | Claude Code hooks | Agent → orchestrator signaling |
| `innovate` | `~/.claude/skills/innovate/` | Fork into `marshall-innovate`: tiers 1–3 only, an issue draft per idea, graveyard read from the `proposals` table |

Gaps Marshall must build: the poller and claims table, the cadence checks, the post-merge rebase and resolver, the hand-off writer, the dashboard, ntfy push, un-scoping the Linear skills from Hemut, and the Innovate agent's proposal store, reply commands, and spec writer.
Built: the Haiku classifier and the autonomous planner (step 04).
Skills agents need must live in the `marshall` plugin at the repo root: agents launch with `--setting-sources project,local`, which never loads `~/.claude/skills/`.

## 12. Technology decisions

| Surface | Decision | Kept as fallback |
|---|---|---|
| Agent runtime | `claude --bg` + daemon, Max login | `claude -p` headless if `--bg` proves flaky |
| Linear intake | Poll via Linear MCP / API key, 30–60 s | Linear OAuth agent + webhooks (v2, needs a tunnel) |
| Claim lock | Linear state + `marshall` label group + local SQLite | Linear `delegate` / AgentSession once the OAuth agent exists |
| Model routing | Haiku classifier → Opus or Fable | Fixed model |
| Reviewer | `code-review` skill, second Claude pass | Cross-model (Codex) if quality demands it |
| Dashboard | Local web app + Tailscale | `claude agents` TUI |
| Push | ntfy.sh | Pushover, Telegram |
| Isolation | Worktree + per-agent Compose project + port offset | Serialize app-dependent steps |
| Voice (later) | iOS Shortcut → webhook → Linear | Telegram voice note → Channels |
| Always-on (later) | Undecided: Mac mini vs VPS vs Routines | — |
| Proposal intake | `proposals` table in Marshall's SQLite + `marshall proposals` CLI replies; one ntfy push per run | Proposals as Linear Triage issues; dashboard card (iteration 2); Telegram replies (iteration 4) |

## 13. Roadmap

### Iteration 1 — Linear autopilot on the laptop, ChessBuddy only

Build steps, dependency graph, and parallel waves: [`steps/README.md`](steps/README.md).

- Poller + claims table + cap of 2 + daily cap + cadence. No overlap check; rebase after merge.
- Haiku classifier + autonomous planner + `ship-plan` implementer + `code-review` reviewer.
- Needs Verification state in the ChessBuddy workspace.
- Hand-off package to Linear, PR, and file.
- ntfy.sh push.
- `claude agents` TUI as the dashboard.
- **Last, after the dry run (step 11):** the Innovate agent. Scheduled `marshall-innovate` runs, the `proposals` table, `marshall proposals` replies, and the spec writer that turns a liked proposal plus my note into a Linear issue (section 16).

### Iteration 2 — Dashboard and hardening

- Web dashboard with panels, queue, hand-off cards, and Kill. Tailscale for phone access.
- Raise the cap to 3 if usage allows.
- Linear OAuth agent so status shows natively in Linear.
- Add approve-and-merge to the dashboard if it turns out to be the action I reach for.
- Proposals card on the dashboard: Like / Pass with a note box, so I can answer the Innovate agent from my phone over Tailscale.

### Iteration 3 — Voice intake

- iOS Shortcut → webhook → Linear issue.
- A cheap model turns the transcript into a well-formed issue with acceptance criteria.

### Iteration 4 — Marshall

- Open-ended goals split into Linear issues, then run the same loop. No separate project agent.
- Two-way chat over Telegram Channels. Replying to proposals moves here too.
- Move to an always-on machine.

### Later — Testing agent

- Same proposal loop as the Innovate agent, for bugs: scan the repo, run the tests, find bugs, propose fixes, wait for my yes, file the issue.
- Not scheduled. Section 16.8 lists what the Innovate agent reserves for it.

### Hemut rollout gate

Marshall touches the Hemut workspace only after ChessBuddy shows a run of issues that landed without a bounce, and after section 14's accepted risks are re-reviewed.

## 14. Risks and accepted trade-offs

| Risk | Why it matters | Mitigation or decision |
|---|---|---|
| False "done" | ~45% of failing runs self-report success without a verifier | Deterministic done gate + `code-review` pass |
| Parallel agents collide | Worktrees isolate files, not ports or the DB | Per-agent Compose project + port offset; no overlap check, rebase every other open Marshall PR after a merge and run a resolver agent on conflict |
| Prompt injection via issue body | An issue body drives an agent with full shell access | **Accepted for ChessBuddy.** Agents run with full permissions. Re-review before Hemut. |
| Real secrets in every worktree | `.env` copied as-is, 2 always-on agents | **Accepted for ChessBuddy.** Re-review before Hemut. |
| Follow-up loops | No depth cap on agent-filed issues | Daily cap and cadence are the brake; `agent-filed` label makes them visible |
| Max plan cap | 2 agents most of the day drain the weekly pool | 6/day, 2 per 5-hour window, reactive pause |
| Laptop sleeps mid-run | Issue stuck in In Progress | Stall timeout + resume ×2 + reconcile on boot |
| Notification fatigue | Too many pushes and I stop reading them | Push only on finished / blocked / over budget / crashed / rate-limit |
| `claude --bg` immaturity | Verified only from `claude --help`; state format may change | `claude -p` fallback; same prompts and skills |
| Proposal spam | Every proposal costs my attention and a Max start | Weekly `quick` run, cap on open proposals, skip when the backlog is full, graveyard so nothing is proposed twice |
| Reply channel injection | My free-text note lands in an issue that an agent runs with full permissions | Replies come only from the CLI in iteration 1. Any remote reply channel must be authenticated: Tailscale dashboard, Telegram allow-list, or an ntfy reserved topic. |

---

## 15. Decisions log — interview of 2026-09-19

Every question from v1, with the answer.

| # | Question | Decision |
|---|---|---|
| 1 | Pickup rules | Every Todo issue assigned to me is pickable. No opt-in label. |
| 2 | Workspace and repo | ChessBuddy workspace (`linear.app/chessbuddy`), team ChessBuddy, repo `~/code/ChessBuddy`. Hemut only after this proves out. |
| 3 | Rejected work | Move the issue back to Todo with a comment. Agent resumes the same branch. Max 3 bounces, then Blocked. |
| 4 | Follow-up depth | No cap. Trust the agents. Label `agent-filed` for visibility. |
| 5 | Identity | Agents act as me in GitHub and Linear. |
| 6 | Done gate | Tests + lint + CI green + a second Claude pass via `code-review`. No cross-model reviewer. |
| 7 | Verification hand-off | Linear comment + PR body + dashboard card. Opens with the `linear-plan` orientation (where to find it, area → part → section, what was wrong, what the agent did), then the recipe. |
| 8 | Evidence | No screenshots or logs. Agent runs tests and review first. Hand-off must let me choose "merge as-is" vs "test by hand." |
| 9 | Model routing | Haiku classifier picks Opus vs Fable for planning. |
| 10 | Retry and time budget | 4 fix cycles. 2 hours wall clock per issue. |
| 11 | Shared services | Per-agent Docker Compose project name and port offset. |
| 12 | Cap scope and overlap | Global cap. Worktrees always. No overlap check; rebase after merge, resolver agent on conflict (revised 2026-09-20). |
| 13 | Orphaned claims | 15-minute stall check + reconcile on boot. Resume up to 2 times, then one fresh start, then Blocked. |
| 14 | Permission boundary | Full permissions. Accepted risk; revisit before Hemut. |
| 15 | Secrets | Real `.env`, copied as `ship-plan` does. Accepted risk; revisit before Hemut. |
| 16 | Budget and rate limits | Stay on Max. Reactive pause on rate-limit errors. 6 starts/day. 2 starts per rolling 5-hour window. Marshall keeps running while I use the laptop. One push on pause, one on resume. |
| 17 | Spawn mechanism | `claude --bg` + the built-in supervisor daemon, with HTTP hooks to the orchestrator. `claude -p` as fallback. **Cap lowered from 3 to 2.** |
| 18 | Laptop setup | Desk, plugged in, lid open. `caffeinate -i`. |
| 19 | Routines vs self-host | Self-hosted daemon on the laptop. |
| 20 | Future always-on machine | Decide later. Mac mini, VPS, and Routines all noted. |
| 21 | Dashboard v1 | Local web app over Tailscale. `claude agents` TUI until it exists. |
| 22 | Push channel | ntfy.sh. Push on finished / blocked / over budget / crashed / rate-limit pause and resume. |
| 23 | Dashboard actions | Read-only plus a Kill button. Approve, reject, reorder stay in GitHub and Linear. |
| 24 | Voice intake | Deferred. Both options noted for iteration 3. |
| 25 | Marshall north star | Split open-ended goals into Linear issues and reuse the same loop. No separate project agent. |

### Still open

- Which always-on machine (Q20).
- Voice intake design (Q24).
- Move the claim lock to `delegate` once the OAuth agent exists (iteration 2).
- What "proven" means for the Hemut rollout gate.
- Innovate agent: proposal store in Marshall's DB or in Linear Triage, and the phone reply channel (section 16.9, step 11).

---

## 16. Innovate agent — added 2026-09-20

**TLDR:** Everything above only builds work that I write down.
The Innovate agent writes the work down for me.
On a schedule it reads the ChessBuddy repo, proposes a few new features, and pushes them to my phone.
I say "like" or "pass" and add a note.
A liked proposal becomes a Linear issue that merges the agent's draft with my note, and a master agent builds it like any other issue.
It is the same idea as my `/innovate` skill, made autonomous and wired into the loop.
Build step: [`steps/11_innovate_agent.md`](steps/11_innovate_agent.md).
It is the last step of iteration 1 and runs only after the dry run (step 10) proves the loop.

### 16.1 What it is

- A fork of the `/innovate` skill (`~/.claude/skills/innovate/`) named `marshall-innovate`.
- It runs as a `claude --bg` session through the same runner as a master agent (step 03).
- It reads the repo. It never writes code, never opens a PR, and never writes to Linear.
- It writes proposals. The orchestrator files the Linear issue, and only after I say yes.

That split is deliberate.
The agent has full shell access, so it must not be the thing that creates work for other full-permission agents.
A human yes sits between "idea" and "issue."

### 16.2 Trigger and budget

- Scheduled: default once a week, in `quick` mode, at a configured hour (`innovate.schedule`).
- On demand: `marshall innovate [focus] [--quick]`.
- A run takes one of the 2 agent slots and counts as one start against the daily cap and the 5-hour window cap.
- A run is skipped, with a logged reason, when:
  - open proposals are at or above `innovate.maxOpen` (default 6),
  - the pickup-ready queue holds `innovate.maxBacklog` (default 5) or more issues,
  - no slot is free, or a cap is reached.

The last two rules stop the agent from proposing work when I already have more than the loop can take.

### 16.3 What a run produces

- `innovate.proposalsPerRun` proposals, default 3.
- Only tiers 1 to 3 of the `/innovate` rubric: Sharpen, Missing piece, New capability.
  Tier 4 and 5 stay in the manual `/innovate` skill.
  A master agent cannot ship a moonshot in a 2-hour clock.
- Every proposal keeps the `/innovate` anchoring rule: at least two named repo artifacts, verified to exist. No anchors, no proposal.
- Each proposal is one file, `~/.marshall/proposals/<id>.md`, and one row in the `proposals` table:
  - `kind` (`feature` now, `bug` later for the Testing agent), title, tier,
  - a one-sentence pitch a 15-year-old would follow,
  - the anchors, the person whose day changes, why now, the hard part,
  - an **issue draft**: problem, proposed change, acceptance criteria, likely touched files, out of scope.
- The issue draft is the part that becomes the Linear issue.
  The rest goes into the issue as background so the planner (step 04) can read it.

### 16.4 Proposal lifecycle

```
Proposed ──like (+note)──▶ Liked ──spec writer──▶ Filed (Linear issue id)
   │
   ├──pass (+reason)──▶ Passed
   └──14 days silent──▶ Expired
```

- Passed and Expired proposals go into the graveyard.
- The next run gets every graveyard title and reason in its prompt as "already proposed, do not repeat," exactly as `/innovate` does with its previous run file.
- A run may supersede a graveyard idea only if it says which one and what changed.

### 16.5 How I reply

Iteration 1 (step 11), from the Mac:

| Command | What it does |
|---|---|
| `marshall proposals` | List open proposals: id, tier, title, age |
| `marshall proposals show <id>` | Print the proposal file |
| `marshall proposals like <id> [--note "..."]` | Approve. The note is my input to the spec. |
| `marshall proposals pass <id> [--note "..."]` | Decline. The note is the graveyard reason. |

Later:

- Iteration 2: a Proposals card on the dashboard with Like, Pass, and a note box. Reached over Tailscale from the phone.
- Iteration 4: reply in the Telegram chat.

Any reply channel that is not the local CLI must be authenticated.
My note flows into an issue that an agent then runs with full permissions, so the channel is an injection path.
See section 14 and open question 2 in step 11.

### 16.6 From Liked to a Linear issue — the spec writer

1. If I gave a note, the orchestrator runs one short `claude -p` call (Opus, non-bare so the Max login works) with the issue draft and my note.
   It returns the final issue text.
   Rules for that call: my note wins wherever it conflicts with the draft; nothing from my note may be dropped; my note appears verbatim under its own **Human input** heading; acceptance criteria must reflect the note.
2. If I gave no note, the issue draft is used as-is. No model call.
3. The orchestrator creates the issue through the Linear client (step 02): ChessBuddy team, state Todo, assigned to me, label `agent-proposed`, priority from my note if it names one, else No priority.
   The description carries the issue draft, the Human input section, and a Background section with the proposal's anchors, tier, and hard part, ending `Origin: Marshall proposal <id>`.
4. The proposal row moves to Filed with the issue id. `proposal_filed` is badge-only, no push.
5. The next poll tick claims the issue like any other Todo issue.

`agent-proposed` is a new team label, created by `marshall linear setup` next to `agent-filed`.
It keeps agent-proposed work visible in Linear the way `agent-filed` does for follow-ups.

### 16.7 Notifications

- `proposals_ready`: one push per run with each proposal's id, tier, and title, default priority.
- `proposal_filed`: badge only.
- No push for a skipped run. The reason is in the log and in `marshall status`.

### 16.8 Later — the Testing agent

Not in scope now.
When it comes, it is the same loop with a different scanner: run the tests, find bugs, propose fixes, wait for my yes, file the issue.
The Innovate agent reserves these things for it so nothing has to be rebuilt:

- The `kind` column on `proposals` (`feature` | `bug`).
- The reply commands, the spec writer, the graveyard, and the push shape, all keyed by proposal id and not by kind.
- The `agent-proposed` label, shared by both.

### 16.9 Open questions

Grill them with step 11.
The two that matter most:

1. **Proposal store.** This section keeps proposals in Marshall's SQLite until I say yes, as asked.
   The alternative is to file every proposal straight into Linear in the Triage state (never pickable), reply by commenting and moving it to Todo, and let the spec writer rewrite the description on that move.
   That reuses "Linear is the state machine" and the bounce mechanism, and gives a phone reply channel for free, at the cost of proposals showing up in Linear before I have seen them.
2. **Phone replies in iteration 1.** CLI only, or an ntfy reply topic (needs a reserved topic or a shared secret, see section 14)?
