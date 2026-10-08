<!-- Last edited: 2026-10-08 13:57 CDT -->

# Plan: Host Marshall on an Oracle Always Free VM

## TLDR

Marshall now runs on your laptop.
It stops when you close the lid.
This plan moves it to a free Oracle server that never sleeps.
You set up the server, install the tools Marshall needs, and give it logins for Claude, GitHub, and Linear.
Then you test it, switch it on, and turn off the laptop copy.
The main risks are that Oracle may be "out of capacity" and that Oracle may reclaim an idle server.

## Context

Marshall is a Bun and TypeScript daemon.
It polls Linear, then launches Claude Code agents with `claude --bg` to plan, implement, and hand off pull requests.
Today it runs under launchd on a Mac (`scripts/install-launchd.sh`).
It stops whenever the laptop sleeps.
The goal is an always-on host at $0.

Research findings that shape this plan:

- Oracle Always Free gives 2 OCPU, 12 GB RAM, and 200 GB disk on Arm (Ampere A1), with no expiry.
  Source: Oracle docs.
- Oracle reclaims an A1 VM that stays under 20% CPU, network, and memory for 7 days.
  Marshall is mostly idle, so this is a real risk.
- The code has no macOS-only logic beyond launchd.
  `marshall start`, `stop`, and `status` only work through launchd (`src/launchd.ts:73`, `src/cli/daemon.ts:10`).
  `marshall run` works on any OS.
- There are no native npm add-ons.
  SQLite is `bun:sqlite`, built into Bun.
  Biome ships an arm64 Linux binary.
  Arm64 is fine for Marshall itself.
- Agents launch with `claude --bg`.
  This needs no TTY.
  It needs the Claude background daemon to work on Linux arm64.
  The docs verified this only on Claude Code 2.1.278 on macOS (`docs/runner.md:5`).
- The code never reads an Anthropic key.
  Auth comes from the environment.
  `docs/project_marshall_plan.md:262` says "Everything uses the Max login. No API key."

## Decisions (defaults, change if you disagree)

1. **Host:** Oracle A1.Flex, 2 OCPU, 12 GB, Ubuntu 24.04 aarch64.
   Fallback: Azure for Students ($100 credit, no card).
2. **Claude auth:** a long-lived OAuth token from `claude setup-token`, on your Max plan.
   An API key costs money and defeats the goal.
3. **Supervisor:** a hand-written systemd user unit around `bin/marshall run`.
   No repo code change in the first pass.
4. **GitHub auth:** a classic personal access token with scopes `repo` and `read:org` only.
   Never add `admin:org`.
   Do not authorize the token for the Hemut org (SSO).
   A fine-grained token does not work here.
   It cannot reach another person's repo, and it has no Checks permission, so `gh pr checks` fails with it.
5. **State:** start with a fresh `~/.marshall` on the VM.
   Do not copy the Mac database.
6. **Target repo:** Jacques's private fork `JacquesAttinger/ChessBuddy`, not TickTick.
   TickTick is a macOS app that needs Xcode (`make test` runs `xcodebuild`), so no Linux host can build it.
   TickTick work stays on the Mac launchd copy, which uses `marshall.config.json`.
   The VM uses `marshall.vm.config.json`, set through `MARSHALL_CONFIG`.

## Step 0: Prove the risky parts first (30 min, before any hosting work)

These three checks decide if the plan works at all.
Run them on the VM as soon as it exists.

1. `claude --version` on Linux arm64 is at least 2.1.278.
   `claude --bg --name probe "say hi"` prints `Started background session <8hex>`.
   `claude stop <id>` stops it.
   Result (2026-10-05): passes on Claude Code 2.1.289, Linux arm64.
   The launch text is now `backgrounded · <8hex> · <name>`, and the job-id parser in `src/runner/launch.ts` still finds the id.
2. `bun --version` is 1.4.2 on linux-aarch64.
   `bun test` in Project_Marshall passes (CI already runs it on Ubuntu x86).
3. The target repo's toolchain installs and its tests run on arm64.
   Result (2026-10-05): TickTick fails this check, because it needs Xcode.
   ChessBuddy passes: `uv run pytest` gives 691 passed, and `docker compose up --build --wait` is healthy on arm64.
   Run this check again for any new target repo.

## Step 1: Oracle account

1. Sign up at oracle.com/cloud/free.
   Use a card for identity check.
   Pick the **home region** with care.
   It cannot change, and free servers must live there.
2. Do not upgrade yet.
   Decide on Pay As You Go after Step 8.

## Step 2: Create the VM

1. Create a `VM.Standard.A1.Flex` instance with 2 OCPU and 12 GB RAM.
   Image: Ubuntu 24.04 (aarch64).
   Boot volume: 100 GB.
   Add your SSH public key.
2. If you see "Out of capacity", retry on another availability domain.
   Retry at off-peak hours.
   After a day of failures, use the Azure fallback.
3. Network: open inbound TCP 22 only.
   Marshall needs no inbound ports (Linear, GitHub, and ntfy are outbound HTTPS).
4. Add 4 GB of swap (`/swapfile`, kept in `/etc/fstab`).
   Three agents with builds can spike memory.

## Step 3: Install tools

On the VM, as a normal user (not root):

1. `sudo apt update && sudo apt install -y git curl unzip build-essential`.
2. Bun, pinned to the CI version: `curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"`.
3. Claude Code, with the official installer.
4. GitHub CLI `gh`, from the apt repo.
5. What ChessBuddy needs: `uv`, Node 24 with Corepack (which gives pnpm 11), and Stockfish.
   On Ubuntu, Stockfish installs to `/usr/games/stockfish`, which is not on the default `PATH`.
6. Docker engine and the compose plugin (`docker.io`, `docker-compose-v2`).
   `marshall.vm.config.json` sets `services` for the ChessBuddy stack.
   Add the user to the `docker` group.
7. Harden SSH: Ubuntu already sets key-only login.
   Add `PermitRootLogin no` in `/etc/ssh/sshd_config.d/99-marshall-hardening.conf`.
8. Trust prompts.
   `claude --bg` refuses to start in a folder you have not trusted: "Workspace not trusted".
   Trust is per git repo, and a trusted parent folder does not cover a git repo inside it.
   Run `ssh -t ... claude` once in `~/code/ChessBuddy` and accept the prompt.
   Check that a new worktree under it inherits this trust, or accept the prompt for each.

## Step 4: Logins and secrets

1. **Claude.**
   On your Mac, run `claude setup-token`.
   Save the output on the VM in `~/.marshall-secrets.env` as `CLAUDE_CODE_OAUTH_TOKEN=...`.
   Run `chmod 600` on that file.
2. **GitHub.**
   The upstream repo `dvairus/ChessBuddy` is owned by another person.
   So the agents use the fork, and PRs land in the fork.
   Use a **classic** personal access token with only two scopes: `repo` and `read:org`.
   Do not add `admin:org`.
   Do not authorize the token for the Hemut org (SSO).
   `gh auth login --with-token` refuses a token without `read:org`, so that scope is required.
   Fine-grained tokens do not work for this setup:
   they cannot reach another person's repo, and they have no Checks permission.
   With a fine-grained token, `gh pr checks` fails.
   With the classic token it works (verified 2026-10-08: `gh pr checks 2` on the fork lists the Python and Web checks).
   Load the token with `read -rs` in a Terminal, so it never enters the chat.
   Run `gh auth login --with-token`, then `gh auth setup-git`.
   Set `git config --global user.name` and `user.email`.
   The token cannot call the fork's "sync with upstream" API.
   To update the fork, push upstream `main` to the fork from the Mac (fast-forward only).
3. **Linear.**
   Put `MARSHALL_LINEAR_API_KEY` in `~/code/Project_Marshall/.env`.
   The key must belong to the workspace in the config: `chessbuddy` for the VM.
   The Mac `.env` key belongs to `todo-timer`, so make a separate key for the VM.
   Load it without chat, and check its workspace before you send it.
4. **ntfy.**
   Copy `NTFY_TOPIC_PREFIX` the same way.
5. Security note: agents run with `--permission-mode bypassPermissions`.
   The VM holds the Claude token and the GitHub token.
   Use this VM for Marshall only.

## Step 5: Install Marshall

1. `mkdir -p ~/code && cd ~/code`.
2. Clone Project_Marshall and your ChessBuddy fork.
   The fork must be at `~/code/ChessBuddy`, because `repoPath` in `marshall.vm.config.json` points there.
   Keep the fork's `main` level with upstream before you start.
3. In Project_Marshall: `HUSKY=0 bun install --frozen-lockfile`.
4. Set `MARSHALL_CONFIG=marshall.vm.config.json`.
   Run `bin/marshall db migrate`, then `bin/marshall linear setup` (idempotent), then `bin/marshall status`.
   Check that `status` shows the right workspace (`chessbuddy`) and no errors.

## Step 6: Smoke tests

1. `bin/marshall queue`.
   It must list pickable issues and write nothing.
2. `MARSHALL_LIVE=1 bun test tests/runner.live.test.ts`.
   It runs four real agents (about 30 s).
   All must pass.
3. `bin/marshall run --once`.
   It does one reconcile, one pulse, and one tick.
4. Create a throwaway Todo issue in Linear.
   Watch one full run in a terminal with `bin/marshall run`.
   Confirm a PR opens and the Linear comment posts.

## Step 7: systemd unit

The repo ships the unit as `scripts/systemd/marshall.service.template`.
`scripts/install-systemd.sh` renders it for this machine and starts it.
It mirrors `scripts/install-launchd.sh`.
Run it from the main checkout, with the VM config:

```bash
sudo loginctl enable-linger $USER
MARSHALL_CONFIG=$HOME/code/Project_Marshall/marshall.vm.config.json scripts/install-systemd.sh
```

Use `--dry-run` to print the unit and change nothing.
The unit it writes is the same as the one below, with absolute paths in place of `%h`.
This is the unit that passed the tests on the VM:

```ini
[Unit]
Description=Marshall
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=%h/code/Project_Marshall
ExecStart=%h/.bun/bin/bun %h/code/Project_Marshall/bin/marshall run
EnvironmentFile=%h/.marshall-secrets.env
Environment=MARSHALL_QUIET=1
Environment=MARSHALL_CLAUDE_BIN=%h/.local/bin/claude
Environment=MARSHALL_CONFIG=%h/code/Project_Marshall/marshall.vm.config.json
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/games
Restart=always
RestartSec=30
KillMode=process

[Install]
WantedBy=default.target
```

Notes:

- `WorkingDirectory` matters because Bun loads `.env` from the working directory.
  That is where the Linear key and the ntfy prefix come from.
- The `PATH` line is required, and `/usr/games` is needed for Stockfish.
  Without `claude` and `bun` on PATH, issues block with `classifier_failed` (see the plist comment in `scripts/launchd/com.jacques.marshall.plist.template`).
- Linger is required, so the unit runs without a login session.
  `sudo loginctl enable-linger $USER`.
- Manual start: `systemctl --user daemon-reload && systemctl --user enable --now marshall`.
  Logs: `journalctl --user -u marshall -f` and `~/.marshall/logs/marshall.log`.
- Over non-interactive ssh, `systemctl --user` worked without extra variables on this VM.
  If you get a bus error, set `XDG_RUNTIME_DIR=/run/user/$(id -u)` and `DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus`.

### What the tests showed (2026-10-08, Ubuntu 24.04 aarch64, Claude Code 2.1.292)

Start:

- `systemctl --user status marshall` showed `active (running)`.
- `bin/marshall status` showed the daemon alive and workspace `chessbuddy`.
- The log showed `run.started` with `"notify":true`, so `NTFY_TOPIC_PREFIX` loaded from `.env`.

Restart test (`systemctl --user restart marshall` while the planner for a throwaway issue ran):

- With `KillMode=process`, the Claude background daemon and the agent stayed alive.
  The agent kept its pid in `claude agents --json`, and it finished normally.
  The Claude background daemon runs inside the `marshall.service` cgroup.
  `KillMode=process` is what keeps it alive, so no `systemd-run` workaround is needed.
- The new daemon logged `reconcile.kept` with `state: planning` and `why: alive`.
- Then the plan phase failed with `launch_failed: attachRunId needs a model` (`src/plan/phase.ts`).
  The cause: `src/phases/plan.ts` passes `attachRunId` but no model.
  The claim stores the model only after the plan succeeds, so a restart during planning has no model to attach with.
  The retry path then reset the worktree and launched a second planner for the same issue.
  The first planner kept running beside it until it finished.
  The second plan was the one used.
  The issue still reached Needs Verification, with a PR and Linear comments.
- So a restart during planning wastes one planner run and starts a duplicate.
  This is a Marshall bug and not a systemd problem.
  It needs a fix in a separate change: save the model on the claim when the planner launches.
- Not tested: a restart during the implement or hand-off phase.

Reboot test (`sudo reboot` with no agent running):

- The VM answered ssh again about 15 s after the reboot.
- `systemctl --user is-active marshall` gave `active`, and `is-enabled` gave `enabled`.
- `bin/marshall status` showed the daemon alive with a new pid.
- The log showed `reconcile.kept` for both parked issues, then `run.started` with `"notify":true`.

Full run on the VM (issue CHE-38, with the Mac closed):

- Todo to planning to implementing to hand-off to Needs Verification took about 9 minutes.
- PR #2 opened on `JacquesAttinger/ChessBuddy`.
  Marshall posted two Linear comments (the plan, and the hand-off).
- `gh pr checks 2` worked from the VM and listed both checks as pass.
- The log shows one `notify.pushed` event (`master.finished`).
  I cannot see the phone, so I did not confirm that the push arrived.

## Step 8: Cutover

Two daemons on one Linear workspace would fight over claims.
Do this in order:

1. On the Mac, wait until `bin/marshall status` shows no live claims.
2. On the Mac, run `bin/marshall stop`.
3. On the VM, run `systemctl --user start marshall`.
4. Watch `bin/marshall status` on the VM for one full poll cycle.
5. Do not re-run `scripts/install-launchd.sh` on the Mac.

## Step 9: Stay alive on Oracle

1. Check that the idle-reclaim rule will not hit.
   Read Oracle's docs on Pay As You Go.
   If it keeps the free limits and stops reclamation, upgrade.
   This is unverified, so confirm before relying on it.
2. Back up `~/.marshall/marshall.db` weekly with cron.
   Copy it to Oracle Object Storage or to a private repo.
3. Keep the Azure for Students account ready as a backup host.

## Optional follow-up PR (separate, not required)

A first-class Linux path, so `marshall start|stop|status` work on Linux:

- Add a systemd runner next to `src/launchd.ts`.
  The file already takes injectable `platform` and `launchctl` dependencies, so the shape fits.
- `scripts/install-systemd.sh` now exists (see Step 7).
- Update `docs/runbook.md`, `README.md:130`, and the hosting question (Q20) in `docs/project_marshall_plan.md`.
- Ship it through a worktree, a PR, and a Linear issue (per your workflow rules).
- Keep `check:size` limits (500 lines per file, 75 per function).

## Verification

1. Step 0 checks pass on the VM.
2. `bin/marshall status` on the VM shows the right workspace and an empty or sane DB.
3. The live runner test passes (4 agents).
4. A throwaway Linear issue goes Todo to PR to hand-off on the VM, with your Mac closed.
   Done 2026-10-08 (CHE-38, PR #2).
5. `gh pr checks <pr>` works from the VM with the classic token.
   Done 2026-10-08.
6. `systemctl --user restart marshall` mid-run: the agent survives and the daemon reconciles.
   Done 2026-10-08 during planning: the agent survived, but the plan phase launched a duplicate planner (see Step 7).
   Not yet tested during implementing or hand-off.
7. Reboot the VM: the unit comes back by itself.
   Done 2026-10-08.
8. A phone receives the ntfy pushes.
   The log shows `notify.pushed`, but nobody has confirmed the phone yet.
9. After 7 days: the VM still exists, and `~/.marshall/logs/marshall.log` shows steady polling.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| No free A1 capacity | Cannot create the VM | Retry; Azure fallback |
| Idle reclaim | VM deleted | Pay As You Go (verify); weekly backup |
| `claude --bg` fails on Linux arm64 | Marshall cannot launch agents | Step 0; fall back to x86 on Azure |
| Target repo needs macOS tools | Agents cannot build or test | Step 0; pick a repo that builds on Linux |
| Fork falls behind upstream | Agents branch from old code | Fast-forward the fork from the Mac before runs |
| Token leak on a bypass-permissions host | Claude and GitHub abuse | Classic token with `repo` and `read:org` only (no `admin:org`, no Hemut SSO), `chmod 600`, single-purpose VM |
| Two daemons running | Double claims | Cutover order in Step 8 |
| Oracle shrinks the free tier again | Less memory | Lower `maxAgents` in `marshall.config.json` |
