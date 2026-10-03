# Marshall dashboard

<!-- Last edited: 2026-10-03 18:30 CDT -->

**TLDR:** The dashboard is a small web page that shows what each Marshall agent does now.
It runs on the laptop as its own program (`marshall dashboard`), so it stays up when the daemon stops.
Open it at `http://127.0.0.1:7474` on the Mac, or through Tailscale on the phone.
It is read-only except for one button: Kill.

## Open it

On the Mac, while the dashboard runs:

```bash
bin/marshall dashboard          # in a terminal, until Ctrl-C
open http://127.0.0.1:7474
```

As a login service, from the main checkout (never from a worktree; the script refuses):

```bash
bash scripts/install-launchd.sh dashboard
```

That installs `~/Library/LaunchAgents/com.jacques.marshall-dashboard.plist`.
It is a separate launchd job: `marshall start` and `marshall stop` do not touch it.
Its logs are `~/.marshall/logs/dashboard.{out,err}.log`; its events also go to `marshall.log`.

The port is `dashboardPort` in `marshall.config.json` (default `7474`).
The server listens on `127.0.0.1` only, so no other machine can reach it directly.

## Open it on the phone (Tailscale)

Tailscale makes a private network of your own devices.
`tailscale serve` gives that network an HTTPS address for the local port.
Only devices logged in to your Tailscale account can open it.

One time:

1. Install Tailscale on the Mac (the macOS app, or `brew install tailscale`) and on the iPhone (App Store).
2. Log in to the same account on both.
3. In the Tailscale admin console, open **DNS** and turn on **HTTPS Certificates** (MagicDNS must be on too).
4. On the Mac: `tailscale serve --bg 7474`.
   `--bg` keeps the setting after a restart.
5. `tailscale serve status` prints the address, `https://<mac-name>.<tailnet>.ts.net`.
   Open it on the phone and add it to the home screen.

To stop sharing it: `tailscale serve reset` (this removes every `serve` setting on the Mac).

The server accepts only these `Host` names: `localhost`, `127.0.0.1`, and any `*.ts.net`.
Other names get 403, so a web page that points its own domain at your laptop cannot read the dashboard (DNS rebinding).

## What each section means

The page refreshes every 5 seconds while the tab is visible.
"Updated N s ago" under the strip turns amber with "Connection lost" when a refresh fails.

### Status strip

- **Daemon running / down.**
  Running means the orchestrator's pidfile names a live process, or launchd reports the job running.
- **Paused by hand since HH:MM** — `marshall pause` is on; `marshall resume` clears it.
- **Rate-limited until HH:MM** — an agent hit the usage limit; new starts wait until then.
- **Queue empty** — no Todo issue is waiting to start (spec section 7).
  It does not show when the Linear call failed.
- `1/3 agents · 4/10 today · 2/10 in 3 h window` — busy slots, starts today, starts in the rolling window, against the caps in the config.

### Needs you

Issues that wait on a person: Needs Verification, Blocked, or Rebasing.
A row shows only while Linear still lists the issue as Needs Verification or Blocked.
If Linear is unreachable, all rows show with a "Not checked against Linear" note.

- **Needs Verification** — the hand-off's TLDR, the PR, the round, and **Show hand-off**, which loads the full six sections.
- **Blocked** — why: the comment Marshall posted to Linear, or (for older rows) the reason from `implement.json`, or the short code in plain words.
- **Rebasing** — rebased and pushed; CI is running.

### Agents

One panel per slot, `maxAgents` slots in all; an empty slot says "idle".
A panel shows the issue, the phase (and the implementer's step, for example "review cycle 2/4"), the model, the time since the claim, the tokens of the current run, and the session's last action.

**Needs you** on a panel means the session waits on input, or it has done nothing for `stallMinutes`.

### Queue

The pickable issues in pickup order, from the same dry run as `marshall queue`, and what the next tick does with each:

| Status | Meaning |
|---|---|
| next start · slot N | It starts on the next tick. |
| slots full | Every agent slot is busy. |
| daily cap | The daily start cap is used up; it resets at local midnight. |
| window cap · frees HH:MM | The rolling-window cap is used up; a slot frees at that time. |
| paused / rate-limited | A pause holds every start. |
| live | Marshall still holds a claim on it. |
| bounce limit | It bounced back too often; the next tick marks it Blocked. |
| human only | It has the `human-only` label; Marshall never picks it up. |

A **bounce #N** tag means a human sent it back and this is its next run.
The Linear lists are cached for 60 seconds.
When a refresh fails, the queue shows the error and the last good list with its time.

## Kill

Tap **Kill** once: the button turns red and says "Tap again to kill TOD-17".
Tap again within 4 seconds to send it; otherwise it resets.

Kill does the same as `marshall kill`:

- With a live orchestrator, it writes the kill flag; the next pulse stops the agent and marks the issue Blocked.
  The panel then says "Kill requested".
- With no orchestrator, it stops the runs itself and marks the issue Blocked in Linear.

Kill is not offered on a conflict resolver (phase "Resolving conflicts"): the orchestrator builds no agent for it, so the flag would be dropped.
Use `marshall stop`, then Kill (or `marshall kill`) stops it directly.

## Security

- `127.0.0.1` only; the tailnet reaches it through `tailscale serve`.
- `Host` allow-list on every request; Kill also needs an `Origin` with the same host.
- Content Security Policy: scripts, styles, and requests only from the page itself; no frames.
- Hand-off Markdown is rendered without raw HTML, without images, and with only `http(s)` and `#` links.
- The dashboard never migrates the database.
  If the database is missing or older than the code, the page says to start the daemon once.
