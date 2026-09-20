# Step 09 — Ops: launchd, Notifications, CLI

<!-- Last edited: 2026-09-19 21:05 CDT -->

**TLDR:** Make Jarvis start on its own, stay awake, tell my phone when something needs me, and give me a terminal view until the web dashboard exists.

## Goal

Jarvis survives a reboot, runs unattended on the desk laptop, pushes to ntfy on the five events that matter, and `jarvis status` shows agents, queue, and "needs you."

## Depends on / parallel with

- Depends on: 08 for the final wiring.
- The ntfy client and the launchd plist can be built right after 01, in wave 2.

## Spec references

Sections 7, 8.1 (Kill), 9, 10.1 of `project_jarvis_plan.md`.

## In scope

### launchd

- `~/Library/LaunchAgents/com.jacques.jarvis.plist` — `KeepAlive`, `RunAtLoad`, logs to `~/.jarvis/logs/`, env with the key file path.
- `caffeinate -i` wrapped around the daemon, or a separate `caffeinate` agent.
- Log rotation, matching `~/claude-tools/*/` scripts.
- No `UserIsActive` gate. Jarvis runs while I use the laptop.

### Notifications `src/notify.ts`

- ntfy.sh, topics `<prefix>-jarvis` for the orchestrator and `<prefix>-agent-<slot>` for each slot.
- Push on: `finished`, `blocked`, `over_budget`, `crashed`, `rate_limited`, `rate_limit_resumed`.
- Badge only (no push): `phase_changed`, queue empty.
- Each push carries the issue identifier, title, and a link (Linear for finished and blocked, nothing for rate limits).
- Priority: `blocked`, `over_budget`, `crashed` high; the rest default.

### CLI `bin/jarvis`

- `status` — agents (slot, issue, phase, elapsed, model), queue (from step 07's `jarvis queue`), needs-you list (issues in Needs Verification or Blocked with the hand-off path).
- `start`, `stop`, `pause`, `resume` — control the daemon and the pause flag.
- `kill <issue>` — the one action from the dashboard spec, available in the terminal now.
- `logs [issue]` — tail the orchestrator log, or `claude logs` for that issue's job.

### Runbook `docs/runbook.md`

- Install, start, stop, where state lives, how to reset a stuck issue by hand, how to clean a slot's Compose project and worktree.

## Out of scope

- The web dashboard and Tailscale. Iteration 2.

## Reuse (search first)

- `~/Library/LaunchAgents/com.jacques.*.plist` and `~/claude-tools/<name>/` — the launchd + log rotation template.
- `~/.claude/hooks/ci-watch-stop.sh` — Slack webhook post; same shape for ntfy.
- `claude agents` — the built-in TUI is the fallback view.

## Deliverables

- The plist, `scripts/install-launchd.sh`, `scripts/uninstall-launchd.sh`.
- `src/notify.ts` + `tests/notify.test.ts` (event → topic + priority mapping, with the HTTP call mocked).
- `bin/jarvis` commands above.
- `docs/runbook.md`.

## Acceptance criteria

- Reboot the laptop: Jarvis is running within a minute and reconciles claims.
- Each of the six push events reaches the ntfy app on the phone in a manual test.
- `jarvis status` output matches `claude agents` for the running jobs.
- `jarvis kill <issue>` stops the job, marks the claim Blocked, and pushes `blocked`.

## Open questions for grilling

1. Public ntfy.sh with a hard-to-guess topic prefix, or self-host later? Public is fine for issue titles; decide if hand-off text should ever go in a push.
2. Should `finished` pushes include the hand-off TLDR line, or only the title and link?
3. `caffeinate` inside the plist, or a separate always-on agent so it survives a Jarvis restart?
4. Should `jarvis pause` also stop running agents, or only stop new starts?
5. Do you want a daily digest push (issues finished, blocked, tokens used), or nothing beyond the event pushes?
