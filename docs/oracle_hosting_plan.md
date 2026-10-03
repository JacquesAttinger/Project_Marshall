<!-- Last edited: 2026-10-03 -->

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
4. **GitHub auth:** a fine-grained personal access token scoped to the target repo only.
5. **State:** start with a fresh `~/.marshall` on the VM.
   Do not copy the Mac database.

## Step 0: Prove the risky parts first (30 min, before any hosting work)

These three checks decide if the plan works at all.
Run them on the VM as soon as it exists.

1. `claude --version` on Linux arm64 is at least 2.1.278.
   `claude --bg --name probe "say hi"` prints `Started background session <8hex>`.
   `claude stop <id>` stops it.
2. `bun --version` is 1.4.2 on linux-aarch64.
   `bun test` in Project_Marshall passes (CI already runs it on Ubuntu x86).
3. The TickTick toolchain (the target repo) installs and its tests run on arm64.
   If a tool has no arm64 build, stop here and use the Azure fallback.

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
4. Add 4 GB of swap.
   Three agents with builds can spike memory.

## Step 3: Install tools

On the VM, as a normal user (not root):

1. `sudo apt update && sudo apt install -y git curl unzip build-essential`.
2. Bun, pinned to the CI version: `curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"`.
3. Claude Code, with the official installer.
4. GitHub CLI `gh`, from the apt repo.
5. Anything the TickTick repo needs (check its README): for example pnpm, uv, Python.
6. Docker engine and the compose plugin, only if a plan needs Compose.
   `marshall.config.json` has `"services": {}`, so skip it for now.
7. Harden SSH: key login only, no root login.

## Step 4: Logins and secrets

1. **Claude.**
   On your Mac, run `claude setup-token`.
   Save the output on the VM in `~/.marshall-secrets.env` as `CLAUDE_CODE_OAUTH_TOKEN=...`.
   Run `chmod 600` on that file.
2. **GitHub.**
   Create a fine-grained token with contents and pull-request write access to the TickTick repo only.
   Run `gh auth login --with-token`, then `gh auth setup-git`.
   Set `git config --global user.name` and `user.email`.
3. **Linear.**
   Put `MARSHALL_LINEAR_API_KEY` in `~/code/Project_Marshall/.env`.
   The key location is in your memory notes: it lives only in the Mac repo `.env`.
   Copy it over with `scp`, not through chat.
4. **ntfy.**
   Copy `NTFY_TOPIC_PREFIX` the same way.
5. Security note: agents run with `--permission-mode bypassPermissions`.
   The VM holds the Claude token and the GitHub token.
   Use this VM for Marshall only.

## Step 5: Install Marshall

1. `mkdir -p ~/code && cd ~/code`.
2. Clone Project_Marshall and the TickTick repo.
   TickTick must be at `~/code/TickTick`, because `repoPath` in `marshall.config.json:11` points there.
3. In Project_Marshall: `HUSKY=0 bun install --frozen-lockfile`.
4. `bin/marshall db migrate`, then `bin/marshall linear setup` (idempotent), then `bin/marshall status`.
   Check that `status` shows the right workspace (`todo-timer`) and no errors.

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

Create `~/.config/systemd/user/marshall.service`:

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
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=30
KillMode=process

[Install]
WantedBy=default.target
```

Notes:

- `WorkingDirectory` matters because Bun loads `.env` from the working directory.
- The `PATH` line is required.
  Without `claude` and `bun` on PATH, issues block with `classifier_failed` (see the plist comment in `scripts/launchd/com.jacques.marshall.plist.template`).
- `KillMode=process` is my guess to protect running agents.
  By default systemd kills every process in the unit's cgroup, which may include the Claude background daemon.
  The launchd docs say a stop leaves live agents running and the next start reconciles them.
  Test this: start an agent, run `systemctl --user restart marshall`, and confirm the agent survives.
  If it does not, move the agents out of the unit's cgroup or accept that a restart parks them.
- Run `sudo loginctl enable-linger $USER` so the unit runs without a login session.
- Then: `systemctl --user daemon-reload && systemctl --user enable --now marshall`.
  Logs: `journalctl --user -u marshall -f` and `~/.marshall/logs/marshall.log`.

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
- Add `scripts/install-systemd.sh` that mirrors `scripts/install-launchd.sh`.
- Update `docs/runbook.md`, `README.md:130`, and the hosting question (Q20) in `docs/project_marshall_plan.md`.
- Ship it through a worktree, a PR, and a Linear issue (per your workflow rules).
- Keep `check:size` limits (500 lines per file, 75 per function).

## Verification

1. Step 0 checks pass on the VM.
2. `bin/marshall status` on the VM shows the right workspace and an empty or sane DB.
3. The live runner test passes (4 agents).
4. A throwaway Linear issue goes Todo to PR to hand-off on the VM, with your Mac closed.
5. `systemctl --user restart marshall` mid-run: the agent survives and the daemon reconciles.
6. Reboot the VM: the unit comes back by itself.
7. After 7 days: the VM still exists, and `~/.marshall/logs/marshall.log` shows steady polling.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| No free A1 capacity | Cannot create the VM | Retry; Azure fallback |
| Idle reclaim | VM deleted | Pay As You Go (verify); weekly backup |
| `claude --bg` fails on Linux arm64 | Marshall cannot launch agents | Step 0; fall back to x86 on Azure |
| TickTick tools lack arm64 builds | Agents cannot run tests | Step 0; Azure x86 fallback |
| Token leak on a bypass-permissions host | Claude and GitHub abuse | Scoped GitHub token, `chmod 600`, single-purpose VM |
| Two daemons running | Double claims | Cutover order in Step 8 |
| Oracle shrinks the free tier again | Less memory | Lower `maxAgents` in `marshall.config.json` |
