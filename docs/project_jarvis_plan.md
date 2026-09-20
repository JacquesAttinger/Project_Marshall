# Project Jarvis — Planning Spec (v2)

<!-- Last edited: 2026-09-19 21:05 CDT -->

## TLDR

Project Jarvis is a robot manager for my coding robots.
It watches my Linear to-do list, picks up open issues, and starts Claude agents that plan and build the fix.
I do not sit at the keyboard.
I watch a dashboard, get a push notification when a robot is done or stuck, and then decide if I need to test it by hand.
Iteration 1 runs on my laptop, watches the ChessBuddy Linear workspace, and runs at most 2 agents at a time.
Later, I talk to Jarvis from my phone and it turns my words into issues and agents.
This is v2 of the spec.
All 25 open questions from v1 are answered in section 15.

---

## 1. Vision

I want to move from "I drive Claude" to "I supervise Claude."
Today I find a Linear issue, run `/linear-plan`, answer questions, and ship.
Tomorrow, a master agent finds the issue, plans it, builds it, opens a PR, and tells me what it did and how to check it.
The end state is a Jarvis-style assistant.
I give it an open-ended goal by voice, and it splits the goal into Linear issues and runs the same loop.

## 2. Scope

### 2.1 Iteration 1 — the Linear autopilot

- A daemon runs on my laptop and watches the **ChessBuddy** Linear workspace (team ChessBuddy) for pickup-ready issues.
- The only repo it works in is `~/code/ChessBuddy`.
- It runs at most **2** master agents at the same time. Raise to 3 after the loop proves itself.
- Each master agent owns one issue from pickup to "Needs Verification."
- A dashboard shows every master agent, its phase, the queue, and a hand-off card for anything that needs me.
- I get a push notification when an agent finishes, is blocked, or the queue pauses for rate limits.
- Agents file out-of-scope work as new Linear issues.

### 2.2 North star — Jarvis

- I speak to Jarvis from my phone or Mac.
- Jarvis turns speech into a Linear issue.
- Jarvis takes open-ended goals ("build a first draft of this web app"), splits them into Linear issues, and runs the same loop.
- Jarvis runs on an always-on machine, not my laptop.

### 2.3 Out of scope for iteration 1

- Voice input.
- Open-ended goal decomposition.
- The Hemut workspace. Hemut comes only after ChessBuddy proves the loop.
- Dedicated hardware or cloud hosting.
- Agents that ask me design questions mid-plan.

## 3. Operating principles

1. **Fast iteration over perfect plans.** Agents do not ask me questions while they plan. They make a call and ship a first draft.
2. **I verify, I do not steer.** My job is to read the hand-off, decide if a manual test is needed, and merge or bounce.
3. **Linear is the state machine.** Every lifecycle change is a Linear state change. The orchestrator keeps only a small local claim table for crash recovery.
4. **Follow-ups are issues.** Anything an agent finds out of scope becomes a Linear issue that the loop picks up later.
5. **Hard cap of 2 master agents, global.** Budget and rate limits, not ambition, set this number.
6. **Push, do not poll.** I get a notification when an agent needs me. I do not watch the terminal.
7. **Jarvis runs while I work.** It does not pause when I am on the laptop. I do LeetCode while Jarvis does my tickets.

## 4. Components

| Component | Role | Decision |
|---|---|---|
| **Scheduler / queue** | Polls Linear, orders issues, enforces cap, cadence, and overlap check | launchd job + SQLite claims table |
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

Failure paths: `Blocked` (agent gave up), `Stalled` (no tool call for 5 minutes), `Over Budget`, `Rate Limited`.
`Blocked` and `Over Budget` push a notification.
`Rate Limited` pauses the whole queue and pushes once.

### 5.3 Pickup contract

1. Poll Linear every 30–60 s for issues in state type `unstarted`, assigned to me, with no delegate.
2. Order by Linear priority, then created date.
3. Skip an issue if the daily cap (6 starts) or the window cap (2 starts per rolling 5 hours) is reached.
4. Skip an issue if the overlap check says its likely code area collides with an active agent. Come back to it on a later tick.
5. Claim with one atomic `issueUpdate`: set delegate to me, move to In Progress, add label `jarvis:<agent-id>`.
6. Re-read the issue. If the delegate is not us, abort.
7. Insert into the local SQLite claims table (unique constraint on issue ID).

### 5.4 Overlap check

Before pickup, a cheap pass estimates which files or modules the issue touches.
If that set overlaps with an active agent's set, the issue waits.
The goal is simple: two agents should not edit the same code at the same time.

## 6. Master agent behavior

### 6.1 Model routing

- A Haiku classifier reads the issue and returns `simple` or `complex`.
- Planner: Opus for `simple`, Fable for `complex`.
- Implementer: Opus always.

### 6.2 Plan phase

- Run an autonomous variant of `linear-plan`: same orientation walkthrough, no `/grilling`, no interview.
- Write the plan to `docs/<topic>_plan.md` in the worktree.
- Post a short summary comment on the Linear issue.

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
- Stall: no tool call for 5 minutes → `Stalled`.
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
- Which ones are waiting on the overlap check, the daily cap, or the window cap.

### 8.3 "Needs you" list

- Every issue in Needs Verification or Blocked.
- Each card shows the full hand-off package or the block reason.

### 8.4 Access and data

- Small web app on the laptop, reached from Mac and phone over Tailscale.
- Read-only except Kill. Approve, reject, and reorder happen in GitHub and Linear.
- Data sources: the orchestrator SQLite DB, `~/.claude/jobs/*/state.json` from `claude --bg`, and the hand-off files.
- Until the web app exists, `claude agents` in a terminal is the stand-in.

## 9. Notifications

- Channel: ntfy.sh. One topic per master agent, one for the orchestrator.
- Push: finished (Needs Verification), blocked, over budget, crashed, rate-limit pause, rate-limit resume.
- Badge only: queue empty, phase changes.

## 10. Infrastructure

### 10.1 Iteration 1 — laptop

- Laptop sits on a desk, plugged in, lid open. `caffeinate -i` keeps it awake.
- The orchestrator runs as a launchd job. Templates exist in `~/Library/LaunchAgents/com.jacques.*`.
- Agents launch with `claude --bg --name <issue-id>`. The Claude daemon supervises them, keeps a roster, and restarts them after a reboot.
- HTTP hooks (`Stop`, `SessionEnd`, `Notification`) post to the orchestrator so it learns about completion without polling.
- Jarvis keeps running while I use the laptop.

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

| Piece | Path | How Jarvis uses it |
|---|---|---|
| `linear-plan` | `~/.claude/skills/linear-plan/` | Fork into an autonomous no-interview variant; its orientation format is the hand-off format |
| `ship-plan` | `~/.claude/skills/ship-plan/` | The implementer step: worktree off `origin/main`, `.env` copy, tests, lint, rebase, PR, CI poll |
| `code-review` | `~/.claude/skills/code-review/` | The second Claude pass in the done gate |
| `linear-sync` | `~/.claude/skills/linear-sync/` | PR → Linear state sync (needs un-scoping from Hemut) |
| `triage` | `~/.claude/skills/triage/` | AGENT-BRIEF format for the planner prompt |
| `session-start-linear-suggest.sh` | `~/.claude/hooks/` | The queue poll query |
| `claude --bg` + supervisor daemon | built in | Background sessions with readable job state |
| launchd templates | `~/Library/LaunchAgents/com.jacques.*` | Always-on scheduler on the laptop |
| HTTP hooks | Claude Code hooks | Agent → orchestrator signaling |

Gaps Jarvis must build: the poller and claims table, the cadence and overlap checks, the Haiku classifier, the autonomous planner, the hand-off writer, the dashboard, ntfy push, and un-scoping the Linear skills from Hemut.

## 12. Technology decisions

| Surface | Decision | Kept as fallback |
|---|---|---|
| Agent runtime | `claude --bg` + daemon, Max login | `claude -p` headless if `--bg` proves flaky |
| Linear intake | Poll via Linear MCP / API key, 30–60 s | Linear OAuth agent + webhooks (v2, needs a tunnel) |
| Claim lock | Linear atomic update + local SQLite | Linear AgentSession |
| Model routing | Haiku classifier → Opus or Fable | Fixed model |
| Reviewer | `code-review` skill, second Claude pass | Cross-model (Codex) if quality demands it |
| Dashboard | Local web app + Tailscale | `claude agents` TUI |
| Push | ntfy.sh | Pushover, Telegram |
| Isolation | Worktree + per-agent Compose project + port offset | Serialize app-dependent steps |
| Voice (later) | iOS Shortcut → webhook → Linear | Telegram voice note → Channels |
| Always-on (later) | Undecided: Mac mini vs VPS vs Routines | — |

## 13. Roadmap

### Iteration 1 — Linear autopilot on the laptop, ChessBuddy only

Build steps, dependency graph, and parallel waves: [`steps/README.md`](steps/README.md).

- Poller + claims table + cap of 2 + daily cap + cadence + overlap check.
- Haiku classifier + autonomous planner + `ship-plan` implementer + `code-review` reviewer.
- Needs Verification state in the ChessBuddy workspace.
- Hand-off package to Linear, PR, and file.
- ntfy.sh push.
- `claude agents` TUI as the dashboard.

### Iteration 2 — Dashboard and hardening

- Web dashboard with panels, queue, hand-off cards, and Kill. Tailscale for phone access.
- Raise the cap to 3 if usage allows.
- Linear OAuth agent so status shows natively in Linear.
- Add approve-and-merge to the dashboard if it turns out to be the action I reach for.

### Iteration 3 — Voice intake

- iOS Shortcut → webhook → Linear issue.
- A cheap model turns the transcript into a well-formed issue with acceptance criteria.

### Iteration 4 — Jarvis

- Open-ended goals split into Linear issues, then run the same loop. No separate project agent.
- Two-way chat over Telegram Channels.
- Move to an always-on machine.

### Hemut rollout gate

Jarvis touches the Hemut workspace only after ChessBuddy shows a run of issues that landed without a bounce, and after section 14's accepted risks are re-reviewed.

## 14. Risks and accepted trade-offs

| Risk | Why it matters | Mitigation or decision |
|---|---|---|
| False "done" | ~45% of failing runs self-report success without a verifier | Deterministic done gate + `code-review` pass |
| Parallel agents collide | Worktrees isolate files, not ports or the DB | Per-agent Compose project + port offset; overlap check at pickup |
| Prompt injection via issue body | An issue body drives an agent with full shell access | **Accepted for ChessBuddy.** Agents run with full permissions. Re-review before Hemut. |
| Real secrets in every worktree | `.env` copied as-is, 2 always-on agents | **Accepted for ChessBuddy.** Re-review before Hemut. |
| Follow-up loops | No depth cap on agent-filed issues | Daily cap and cadence are the brake; `agent-filed` label makes them visible |
| Max plan cap | 2 agents most of the day drain the weekly pool | 6/day, 2 per 5-hour window, reactive pause |
| Laptop sleeps mid-run | Issue stuck in In Progress | Stall timeout + resume ×2 + reconcile on boot |
| Notification fatigue | Too many pushes and I stop reading them | Push only on finished / blocked / over budget / crashed / rate-limit |
| `claude --bg` immaturity | Verified only from `claude --help`; state format may change | `claude -p` fallback; same prompts and skills |

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
| 12 | Cap scope and overlap | Global cap. Worktrees always. Overlap check at pickup; prefer non-overlapping issues. |
| 13 | Orphaned claims | 5-minute stall check + reconcile on boot. Resume up to 2 times, then one fresh start, then Blocked. |
| 14 | Permission boundary | Full permissions. Accepted risk; revisit before Hemut. |
| 15 | Secrets | Real `.env`, copied as `ship-plan` does. Accepted risk; revisit before Hemut. |
| 16 | Budget and rate limits | Stay on Max. Reactive pause on rate-limit errors. 6 starts/day. 2 starts per rolling 5-hour window. Jarvis keeps running while I use the laptop. One push on pause, one on resume. |
| 17 | Spawn mechanism | `claude --bg` + the built-in supervisor daemon, with HTTP hooks to the orchestrator. `claude -p` as fallback. **Cap lowered from 3 to 2.** |
| 18 | Laptop setup | Desk, plugged in, lid open. `caffeinate -i`. |
| 19 | Routines vs self-host | Self-hosted daemon on the laptop. |
| 20 | Future always-on machine | Decide later. Mac mini, VPS, and Routines all noted. |
| 21 | Dashboard v1 | Local web app over Tailscale. `claude agents` TUI until it exists. |
| 22 | Push channel | ntfy.sh. Push on finished / blocked / over budget / crashed / rate-limit pause and resume. |
| 23 | Dashboard actions | Read-only plus a Kill button. Approve, reject, reorder stay in GitHub and Linear. |
| 24 | Voice intake | Deferred. Both options noted for iteration 3. |
| 25 | Jarvis north star | Split open-ended goals into Linear issues and reuse the same loop. No separate project agent. |

### Still open

- Which always-on machine (Q20).
- Voice intake design (Q24).
- The exact overlap-check heuristic (file globs from the plan? a Haiku guess from the issue text?).
- What "proven" means for the Hemut rollout gate.
