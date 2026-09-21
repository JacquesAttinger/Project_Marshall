# Marshall runbook

<!-- Last edited: 2026-09-21 02:05 CDT -->

**TLDR:** Marshall runs as a launchd agent on the desk laptop.
`scripts/install-launchd.sh` installs it, `marshall status` shows what it is doing, `marshall stop` / `start` / `pause` / `resume` / `kill` control it, and ntfy pushes tell your phone when an issue needs you.
Everything Marshall writes lives under `~/.marshall`.
This page says how to install it, read it, stop it, and repair it by hand.

## Install

Once per machine, from the repo:

```bash
cp .env.example .env            # fill in MARSHALL_LINEAR_API_KEY and NTFY_TOPIC_PREFIX
bun install
bun bin/marshall db migrate
bash scripts/install-launchd.sh
marshall status                 # Daemon: launchd running (pid N), orchestrator alive
```

The script renders `scripts/launchd/com.jacques.marshall.plist.template` with this machine's `bun`, the repo path, and `$HOME`, writes `~/Library/LaunchAgents/com.jacques.marshall.plist`, and bootstraps it.
The plist runs `caffeinate -i bun bin/marshall run` with the repo as the working directory (so Bun loads `.env`), `KeepAlive` (a crash restarts it after 30 s), and `RunAtLoad` (login and reboot start it).
`caffeinate` execs `bun` in place and forks a child that holds the sleep assertion, so the pid launchd shows is the daemon's own (`pmset -g assertions` lists the child).
Rerun the script after moving the repo or changing the template; it boots the old agent out first.

`marshall` on `PATH`: `bun link` in the repo, or call `bun bin/marshall ...`.

Uninstall: `bash scripts/uninstall-launchd.sh`.
State under `~/.marshall` stays.

## Start, stop, pause, resume, kill

| Command | What it does |
|---|---|
| `marshall start` | `launchctl bootstrap` the plist. Says so when the agent is already running. |
| `marshall stop` | `launchctl bootout`. The daemon exits; live agent jobs keep running under the Claude daemon, and the next start's reconcile attaches to them. A reboot re-loads the plist on its own. |
| `marshall pause` | No new issues start. Running agents finish their issue. Independent of the rate-limit pause: a rate-limit resume never clears it. |
| `marshall resume` | Clears the manual pause. Mentions a rate-limit pause that is still in effect. |
| `marshall kill <ID>` | Stops one issue's agent and marks the issue Blocked (with a `blocked` push). With a live orchestrator this writes a flag its next pulse executes (within `pollSeconds`). Without one, it kills the runs and blocks the issue itself, which needs the Linear key. |
| `marshall run` | The daemon in the foreground, for a terminal session. `--once` does one reconcile, pulse, tick, and notify tick, then exits. |

The daemon writes `~/.marshall/marshall.pid` and removes it on a clean exit.
`kill` and `status` read it; a stale file (crash, power loss) reads as "not running" once its pid is gone.

## Reading it

`marshall status` prints, after the config and DB summary:

- **Daemon** — launchd state (`running (pid N)`, `installed but not loaded`, `not installed`), the orchestrator pidfile, and the pause flags.
- **Agents** — one row per live claim: slot, issue, phase, model, elapsed since claim, the newest run in its worktree with the daemon job id, title.
- **Queue** — the same dry run as `marshall queue` (needs the Linear key and network; says why when it cannot run).
- **Needs you** — every issue in Needs Verification or Blocked, with its PR and the hand-off path when the package exists.

`--json` gives the same as one object (`ops` holds the four sections).

`marshall logs` tails `~/.marshall/logs/marshall.log` (JSONL, one event per line).
`marshall logs <ID>` prints the newest run for that issue, its transcript path, and hands the terminal to `claude logs <jobId>`.
`claude agents` is the daemon's own view of the background jobs.

## Where state lives

| Path | What |
|---|---|
| `~/.marshall/marshall.db` | SQLite: `claims`, `starts`, `events`, `runs`, `flags`. WAL mode, so `marshall status` can read while the daemon writes. |
| `~/.marshall/marshall.pid` | The live orchestrator's pid and start time. |
| `~/.marshall/logs/marshall.log` | The orchestrator's JSONL log. Rotated at daemon start above 5 MB, three generations kept (`.1`, `.2`, `.3`). |
| `~/.marshall/logs/launchd.{out,err}.log` | The daemon's stdout and stderr, written by launchd. Rotated the same way; launchd keeps its handle, so the rotated file fills until the next restart. |
| `~/.marshall/handoffs/<ID>.md` + `.json` | The hand-off package and what was posted where. |
| `~/.marshall/issues/<ID>/` | Per-issue files the skills write (`implement.json`, `resolve.json`). |
| `~/.marshall/briefs/`, `~/.marshall/events/` | Planner briefs; the hook JSONL each run appends to. |
| `<repo parent>/<repo>-<branch>` | One git worktree per claimed issue, next to the target repo. |
| `~/.claude/jobs/<jobId>/state.json` | The Claude daemon's record of each background job (read-only for Marshall). |

`MARSHALL_HOME` moves the whole tree; the tests set it to a temp dir.

The `flags` table holds the switches: `pause_until` (rate-limit pause), `paused` (manual pause), `notify_cursor` (the last event id pushed), `kill:<issueId>` (a pending kill).

## Notifications

Pushes go to public ntfy.sh under a hard-to-guess prefix from `.env`: `NTFY_TOPIC_PREFIX=<prefix>`.
Subscribe the phone to `<prefix>-marshall` and `<prefix>-agent-0`, `<prefix>-agent-1` (one per slot up to `maxAgents`).

| Event | Topic | Priority | Link |
|---|---|---|---|
| `finished` (Needs Verification) | agent slot | default | Linear issue |
| `blocked` | agent slot | high | Linear issue |
| `over_budget` | agent slot | high | Linear issue |
| `crashed` | marshall | high | Linear issue |
| `rate_limited` | marshall | default | none |
| `rate_limit_resumed` | marshall | default | none |

The body is the issue title, plus the block reason code or the pause end.
Hand-off text never leaves the laptop.
Phase changes, stalls, resumes, and rebases are badge-only (no push).

The tailer reads the `events` table every 10 s from `notify_cursor`; a failed POST is retried on later ticks, three times, then skipped with a `notify.push_skipped` log line.
The cursor starts at the newest event, so an install or a restart never replays history.
Without `NTFY_TOPIC_PREFIX` the tailer is off (one `notify.disabled` log line).

Test the phone end to end, one sample push per event:

```bash
marshall notify test all            # or one of: finished blocked over_budget crashed rate_limited rate_limit_resumed
```

## Reset a stuck issue by hand

Symptoms: an issue sits In Progress with a `marshall/agent-N` label and nothing is running, or a claim row holds a slot with no agent.

1. `marshall status` — is the orchestrator alive? Is the issue in **Agents**? `claude agents` — is there a job for it?
2. If the daemon is alive and the issue is live: `marshall kill <ID>`. Done; the issue is Blocked with a comment.
3. If the daemon is down: `marshall start`. Reconcile resumes a claim whose job ended, or releases it to Todo after `maxResumes`. Wait one poll, check `marshall status` again.
4. Only when that fails, edit by hand. Stop the job: `claude stop <jobId>` (from `marshall status` or `claude agents`). Then:

```bash
sqlite3 ~/.marshall/marshall.db
-- see the row
SELECT issue_id, identifier, slot, state, worktree_path FROM claims WHERE identifier = 'CB-12';
-- free the slot; 'released' or 'blocked' both work. Keep the row: bounces and the branch live on it.
UPDATE claims SET state = 'released', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE identifier = 'CB-12';
-- a run the daemon no longer knows about
UPDATE runs SET state = 'killed', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cwd = '<worktree_path>' AND state IN ('starting','running');
-- clear a stale flag
DELETE FROM flags WHERE key = 'kill:<issue_id>';
```

In Linear: remove the `marshall/agent-N` label and set the state to Todo (to run again) or Blocked (to park it).
A `released` row with a branch means the next pickup is a bounce (same branch, plan revised).
To start over instead, also `UPDATE claims SET branch = NULL, plan_path = NULL, pr_url = NULL WHERE identifier = 'CB-12';` and delete the worktree (below).

## Clean a slot's Compose project and worktree

Each slot runs the target repo's Compose stack under the project name `marshall-<slot>` with host ports `base + slot * portOffsetPerSlot`.
After a killed or crashed implement run the containers can be left up:

```bash
cd <worktree_path>                                      # from marshall status or the claims row
docker compose -p marshall-0 down --volumes --remove-orphans
docker compose -p marshall-0 ps                         # nothing
```

The worktree:

```bash
cd <target repo>
git worktree list
git worktree remove --force <worktree_path>             # --force: the agent's uncommitted work is gone with it
git branch -D <branch>                                  # only if the PR is closed and the branch is not wanted
```

A claim row that still names the worktree is fine: the next pickup recreates it (`worktrees.create` for a fresh start, `reuse` for a bounce).

## When something is wrong with the daemon itself

- `marshall status` says `installed but not loaded`: `marshall start`. If bootstrap fails, `launchctl print gui/$(id -u)/com.jacques.marshall` and `~/.marshall/logs/launchd.err.log` say why.
- The daemon restarts in a loop: `~/.marshall/logs/launchd.err.log` has the stack. Common causes: `.env` missing in the repo (the plist's working directory), `marshall.config.json` invalid, `bun` moved (rerun the install script).
- The laptop slept: `caffeinate -i` only prevents idle sleep. A closed lid or a manual sleep stops everything; on wake, launchd is still running the daemon, and reconcile picks the agents up.
- Pushes stopped: `marshall notify test finished`. Then `grep notify ~/.marshall/logs/marshall.log | tail`.
