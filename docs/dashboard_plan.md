# Marshall Dashboard — Plan

<!-- Last edited: 2026-10-03 CDT -->

## TLDR

We build a small web page that shows what each Marshall agent does now.
The page runs on the laptop as its own program, so it stays up when the Marshall daemon stops.
The page shows four things: the issues that wait for you (with the agent's hand-off note), the live agents, the queue, and a two-tap Kill button.
Your phone opens the page through Tailscale, a private tunnel that only your own devices can use.
We add no new library: Bun makes the HTML, and one small script refreshes the page every 5 seconds.

## Context

Plan section 8 (`docs/project_marshall_plan.md`) specifies a web dashboard: agent panels, queue, a "needs you" list with hand-off cards, and a Kill button.
Iteration 1 used `marshall status` and `claude agents` as stand-ins.
Steps 01–09 are built and the dry-run tuning is merged (PRs #13–#23).
The dashboard is the first item of iteration 2 (plan section 13).
Today, to see what the agents do, Jacques must open a terminal on the laptop.
The goal is one glance from the Mac or the phone.

## Decisions (grilling of 2026-10-03)

| # | Question | Decision |
|---|---|---|
| 1 | v1 scope | Full section 8: status strip, "needs you" cards, agent panels, queue with cap status, Kill. No proposals card (step 11 is not built). |
| 2 | Access | Mac + phone over Tailscale. The server listens on `127.0.0.1` only; `tailscale serve` gives the tailnet an HTTPS URL. No login code. |
| 3 | Process | Separate `marshall dashboard` process with its own launchd job (`com.jacques.marshall-dashboard`). It shows "daemon down" when the daemon is down. `marshall start/stop` do not touch it. |
| 4 | Frontend | Server-rendered HTML from pure TypeScript template functions + one vanilla JS file + one CSS file. No framework, no build step, no new dependency. |
| 5 | Laptop off | Accepted. Laptop off means agents off too. Hand-offs stay readable in Linear and GitHub. An always-on machine (plan 10.3) fixes it later with no dashboard change. |
| 6 | Queue data | The dashboard calls `collectQueue()` with its own read-only Linear client, cached 60 s. |
| 7 | Kill | Two taps: the first tap turns the button red ("Tap again to kill TOD-17") for 4 s. Same logic as `marshall kill`: flag when the daemon is alive, direct kill + Blocked when it is not. |
| 8 | Hand-off cards | TLDR, state badge, PR and Linear links; a native `<details>` "Show hand-off" opens the full six sections. Blocked cards show the block reason. |
| 9 | Phone order | Status strip → Needs you → Agents → Queue. Wide screens use two columns (Needs you left, Agents right, Queue under Agents). |
| 10 | Tracking | No Linear issue. Plan doc + PR only, like steps 01–09. |

## Design

### Page content

**Status strip** (top, always visible):
- Daemon: running / down / paused (manual, since HH:MM) / rate-limited until HH:MM.
  Daemon state from `daemonStatus()` + `liveOrchestrator()`; pause from `readCapCounts()` (`pausedAt`, `pausedUntil` — time-checked, unlike `collectOps().pausedUntil`).
- `2/3 agents · 4/10 today · 2/10 in window` from `readCapCounts()` + config.
- "Queue empty" badge (plan section 7) when the queue has no `fresh` or `bounce` row. Not shown when the Linear call failed.
- "Updated 3 s ago"; turns amber with "connection lost" when a refresh fails.

**Needs you**:
- Rows: DB claims in `awaiting_human`, `blocked`, or `rebasing`, **filtered by Linear**: keep a row only when `linear.listAwaitingMerge()` (`src/linear/client.ts:268`, same 60 s cache as the queue) still lists that issue as Needs Verification or Blocked.
  Reason: nothing moves a claim out of `blocked` after the issue is Done or cancelled, and the real DB holds 10 stale `blocked` rows since 2026-09-22.
  When Linear is unreachable, show the unfiltered DB rows with a "not checked against Linear" note.
- Each card: issue ID linked to Linear, title, state badge (Needs Verification / Blocked / Rebasing), age.
- Awaiting: TLDR (`tldrOf()` from `src/markdown.ts`, `**TLDR:**` prefix stripped, rendered with the same sanitizer), PR link, round badge (`readHandoffMeta()`), and a `<details>` "Show hand-off" whose body loads on open from `GET /handoff/:identifier`.
- Blocked: the block reason (see "Block reason" below).
- Empty state: "Nothing needs you."

**Agents** (one panel per slot, `maxAgents` slots; idle slots show "Slot 3 · idle"):
- Issue ID + title linked to Linear, phase, model, elapsed, tokens, last action.
- Phase label: claim state → plain words: `claiming`/`claimed` Starting, `planning` Planning, `implementing` Implementing, `handoff` Writing hand-off, `resolving` Resolving conflicts, `rate_limited` Rate-limited.
  While implementing, add the sub-phase from `readImplementStatus(identifier)`, e.g. "Implementing · review cycle 2/4".
- Tokens (current run) and last action: from the job state of the claim's newest run → `tokens` and `detail`. Extend `JobState` to read `detail`, `tempo`, `needs`.
- "Needs you" flag when the job's `tempo` is `blocked`, `needs` is set, or the run is stalled.
- Kill button (two taps). Shows "kill requested" while the `kill:<issueId>` flag is set.
  **Hidden on `resolving` claims** with the note "resolver running — use `marshall stop`": the daemon builds no MasterAgent for them, so `pulseKills` clears the flag as `kill_no_agent` (`src/master/orchestrator.ts:37-41`). Known gap; follow-up.

**Queue** (from `collectQueue()`): ID, title, priority, status.
- Status comes from new structured codes, not from parsing the free-text reasons: next start / slots full / daily cap / window cap · frees 16:40 / paused / live / bounce / bounce limit / human only.
- While a refresh runs, the old list stays; one in-flight Linear request is shared. When Linear fails, the section shows the error and the last good list with its time.

### Block reason

`blockIssue()` (`src/scheduler/tick.ts:62-80`) stores only a short `why` code (`blocked`, `missing_sections`, `launch_failed`, `killed`…); the sentence goes only to the Linear comment.
- Add the comment text to the `master.blocked` event payload (`comment`) at `tick.ts:74`, and update `docs/state_machine.md:85`.
- For old rows without `comment`: when `why` is one of `IMPLEMENT_OUTCOMES` (`src/implement/status.ts:23`), use `readImplementStatus(identifier).reason`; otherwise map the code to plain words.
- New helper `latestBlockEvent(db, issueId)` in `src/scheduler/store.ts`, keyed by the Linear UUID (covered by the `events_issue` index).

### Issue keys

Two keys are in play, and mixing them is the easy bug:
- Linear UUID (`claims.issue_id`): `killFlag()`, `events.issue_id`.
- Identifier (`TOD-17`): `handoffPath()`, `readHandoffMeta()`, `readImplementStatus()` (their parameter is named `issueId` but takes the identifier).

`data.ts` reads `liveClaims()` / `claimsInStates()` directly so it has both keys. `AgentRow` / `NeedsYouRow` stay unchanged, so `tests/status-ops.test.ts:84` keeps passing.

### Server

- `Bun.serve` on `127.0.0.1:<config.dashboardPort>` (new config key, default `7474`, free on this Mac). `startDashboard({ port })` takes an explicit port so tests can use `0`.
- `development: false` and an `error()` handler that returns a plain 500. (Bun's default dev error page leaks the error and inline scripts; NODE_ENV is unset under launchd.)
- Routes (every handler wrapped in the guard; `routes` run before `fetch`, so a guard only in `fetch` never runs):
  - `GET /` — full page.
  - `GET /sections` — JSON `{ strip, needsYou, agents, queue }` HTML strings, plus a hash per section so the client skips unchanged ones.
  - `GET /handoff/:identifier` — the sanitized hand-off HTML.
  - `POST /kill/:identifier` — `{ ok, message }`, shown inline on the panel (no browser dialog).
  - `GET /assets/dashboard.js`, `GET /assets/dashboard.css` — `Bun.file(join(import.meta.dir, "assets", …))`.
- Guards:
  - Host allow-list on every request, port stripped: `localhost`, `127.0.0.1`, any `*.ts.net`. Blocks DNS-rebinding pages.
  - `POST /kill`: `Origin` host (not scheme) must equal the request host. The browser's Origin is `https://…ts.net` while the server sees http.
- Headers: CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, plus `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- Escaping: every interpolated value goes through one `html` tagged-template helper that escapes by default.
- Hand-off Markdown: strip HTML comments (the `<!-- Last edited -->` header), then `Bun.markdown.html(md, { noHtmlBlocks: true, noHtmlSpans: true })`, then `HTMLRewriter`: keep `a[href]` only for `http(s):` and `#`, add `rel="noopener noreferrer"`, remove `img`.
- Fault isolation: each per-item read (`readJobState`, `readImplementStatus`, `readHandoffMeta`, the hand-off file) is caught and degrades only that field, so one half-written file never blanks the page.
- Caching: section data cached 4 s — one `listDaemonSessions()` (~0.1 s) and one `launchctl print` per window, shared by all tabs. Linear data (queue + `listAwaitingMerge`) cached 60 s, stale-while-refresh. One Linear client, created lazily, re-created after an error. The Linear key is optional at start (as in `src/cli/status.ts:94`); without it, the queue section explains why.
- DB: `openDb()` only, **no `migrate()`** (like `marshall status`, `src/cli/status.ts:33`), so the dashboard never races the daemon's migration at login. If the DB is missing or its `user_version` is older than the code expects, the page says "Start the daemon once to create or update the database." This PR adds no migration.

### Stalled check without one subprocess per run

`isStalled()` → `status()` spawns `claude agents --json --all` per run (`src/runner/status.ts:121-153`).
- Split a pure `statusFrom(db, run, job, sessionsById)` out of `status()`; `status()` becomes a thin wrapper, so the daemon is unchanged.
- The dashboard calls `listDaemonSessions()` once per 4 s window and reuses each job state for tokens, `detail`, and the stall check.
- Export `newestHookEventAt` from `src/runner/index.ts`.

### Kill (`requestKill`)

Extract `requestKill(deps, identifier): Promise<KillResult>` into `src/kill.ts`; `src/cli/kill.ts` becomes a wrapper that prints the same messages.
- Deps are injected: `db`, `config`, `log`, `now`, `linear: () => Promise<LinearClient>`. The server passes its cached client; the CLI builds one as today.
- The API-key check stays before `killRuns()`, so `tests/cli-ops.test.ts:108-120` still sees `rejects.toThrow(/MARSHALL_LINEAR_API_KEY/)`.
- "Orchestrator alive" = pidfile alive **or** launchd reports `running`. The daemon writes its pidfile only after `connectLinear` + `migrate` (`src/cli/run.ts:56-89`); without this, a kill in that gap would race the daemon's reconcile.
- The server runs at most one direct kill per identifier at a time (phone and Mac tapping together).
- `KillResult`: `flagged` / `already_requested` / `killed_directly { runsStopped }` / `no_claim` (404) / `not_live { state }` (409) / `not_killable { state: "resolving" }` (409).

### Client (`dashboard.js`)

- Every 5 s, `fetch('/sections')`; replace only the sections whose hash changed.
- Keep open `<details>` open across swaps (match by `data-id`), keep scroll position, and do not refetch a hand-off that is already loaded.
- Armed-Kill state lives in a JS map by identifier, not in the DOM, and is re-applied after each swap. (A swap every 5 s would otherwise wipe the armed state between the two taps.)
- Pause polling when the tab is hidden (`visibilitychange`); refresh at once when it is visible again.
- No inline scripts or styles (CSP).

### Style (`dashboard.css`)

- Phone-first single column, 16 px side gutter, no horizontal scroll at 375 px.
- Two columns at ≥ 960 px.
- Light and dark from `prefers-color-scheme`, colors as CSS variables.
- System font stack. State colors: amber = needs you, red = blocked / armed Kill, green = running.

## Files

New:
- `src/dashboard/server.ts` — `startDashboard()`: routes, guards, headers, error handler, concurrency guard for kills.
- `src/dashboard/data.ts` — `collectDashboard()`: claims, runs, job states, flags, sub-phase, block reasons, cap counts, Linear filter. Plus the 4 s / 60 s caches (split into `cache.ts` if `data.ts` nears 500 lines).
- `src/dashboard/html.ts` — `html` escaping tag, `raw()`, `renderHandoffMarkdown()`.
- `src/dashboard/render/{strip,needs-you,agents,queue,page}.ts` — pure template functions.
- `src/dashboard/assets/dashboard.js`, `src/dashboard/assets/dashboard.css`.
- `src/kill.ts` — `requestKill()`.
- `src/linear/url.ts` — `linearIssueUrl(workspace, identifier)`; used by the dashboard, `src/notify.ts:114`, and `src/phases/rebase.ts:206`.
- `src/cli/dashboard.ts` — `runDashboard()`: load config and env, open the DB, start the server, log the URL, wait for SIGTERM/SIGINT with `untilSignal()` (export it from `src/cli/run.ts:40`; `main()` exits as soon as a command returns).
- `scripts/launchd/com.jacques.marshall-dashboard.plist.template` — `zsh -lc "exec {{BUN}} {{REPO}}/bin/marshall dashboard"`, same `MARSHALL_CLAUDE_BIN`, `PATH`, `WorkingDirectory` (Bun finds `.env` there), and `MARSHALL_QUIET` as the daemon plist; own `logs/dashboard.{out,err}.log` (the daemon's `rotateLogs()` renames `launchd.*.log` at each start); KeepAlive, RunAtLoad, `ProcessType` Standard, no `caffeinate`.
- `docs/dashboard.md` — what each section means, how to open it, Tailscale setup (macOS app/CLI, HTTPS certificates on in the admin console, `tailscale serve --bg 7474`).
- Tests: `tests/dashboard/{render,data,server}.test.ts`, `tests/kill.test.ts`.

Changed:
- `src/cli/kill.ts` — wrapper over `requestKill()`.
- `src/cli/index.ts` — `dashboard` command + usage line.
- `src/cli/run.ts` — export `untilSignal`.
- `src/config.ts` + `marshall.config.json` — `dashboardPort` (`port` schema, default 7474), with a comment; the file header says the daemon *and the dashboard* read it.
- `src/runner/status.ts` — `JobState` reads `detail`, `tempo`, `needs`; `statusFrom()` split out. `src/runner/index.ts` — export `newestHookEventAt`.
- `src/scheduler/tick.ts` — `comment` in the `master.blocked` payload. `src/scheduler/store.ts` — `latestBlockEvent()`.
- `src/caps.ts` + `src/cli/queue.ts` — structured reason codes on `CapCheck` / `QueueRow` next to the existing text (the CLI text is unchanged).
- `src/notify.ts`, `src/phases/rebase.ts` — use `linearIssueUrl()`.
- `scripts/install-launchd.sh`, `scripts/uninstall-launchd.sh` — take a target `daemon | dashboard | all` (default `all` for install, required for uninstall), and refuse to run from a path under `.worktrees/` (`REPO` comes from the script's location, so a worktree run would point the real daemon at the feature branch).
- `scripts/check-size.ts` — also scan `.js`. `.lintstagedrc` — add `js,css`.
- `docs/state_machine.md:85`, `docs/runbook.md` (dashboard section, `launchctl kickstart -k gui/$(id -u)/com.jacques.marshall-dashboard` after an update), `README.md` (split the iteration 2 checkbox at `:212` and tick the dashboard), `docs/project_marshall_plan.md` (section 8.4 + a new "Dashboard decisions — 2026-10-03" table under section 15).

Every new or edited file keeps the "Last edited" header; files stay under 500 lines and functions under 75 (`bun run check:size`).

## Reuse

| Need | Existing code |
|---|---|
| Claims | `liveClaims()`, `claimsInStates()` — `src/scheduler`; `modelFor()`, `formatElapsed()` — `src/cli/status-ops.ts` |
| Daemon state | `daemonStatus()` — `src/launchd.ts:69`; `liveOrchestrator()` — `src/pidfile.ts:46` |
| Caps, pause | `readCapCounts()`, `evaluateCaps()` — `src/caps.ts:108,125` |
| Queue, needs-you filter | `collectQueue()` — `src/cli/queue.ts:51`; `connectLinear()`, `listAwaitingMerge()` — `src/linear/client.ts` |
| Job state | `readJobState()`, `listDaemonSessions()` — `src/runner/status.ts`; `latestRunInCwd()` — `src/runner` |
| Implement sub-phase, old block reasons | `readImplementStatus()`, `IMPLEMENT_OUTCOMES` — `src/implement/status.ts` |
| Hand-off | `handoffPath()` — `src/paths.ts:50`; `readHandoffMeta()` — `src/handoff/meta.ts:27`; `tldrOf()` — `src/markdown.ts:48` |
| Kill | `killFlag()`, `KILLED` — `src/master/types.ts`; `blockIssue()` — `src/scheduler/tick.ts:62`; `kill()`, `listActiveRuns()` — `src/runner`; `getFlag()`, `setFlag()` — `src/scheduler/store.ts` |
| Launchd | daemon plist template + `install-launchd.sh` render pattern |
| Tests | `useTempHome()`, `useTempConfig()` — `tests/helpers.ts`; `seedClaim()` — `tests/scheduler/helpers.ts`; fake Linear client — `tests/scheduler/fake-client.ts`; `useRunnerEnv()` + `tests/fixtures/jobs` — `tests/runner/helpers.ts`; `daemon: { platform: "linux" }` as in `tests/status-ops.test.ts:43` |

## Tests

All tests inject `daemon: { platform: "linux" }` and a fake sessions source, so they never call the real `launchctl` or `claude`.
- `render.test.ts`: escaping of a title with `<script>`; hand-off Markdown with raw HTML, an HTML comment, an `<img>`, and a `javascript:` link comes out inert; empty states (no agents, nothing needs you, queue-empty badge, queue error with last good list, Linear-unchecked note); blocked card reason; awaiting card TLDR + `<details>`; idle slots; Kill hidden on `resolving`; every queue status code.
- `data.test.ts`: seeded claims, runs, events, and job fixtures → tokens, `detail`, needs flag, stalled flag, sub-phase, block reason (new `comment`, old `why` + `implement.json`, plain-words fallback); stale blocked rows dropped by the Linear filter; a corrupt `state.json` degrades one field only; Linear calls once per 60 s and once in flight.
- `server.test.ts`: port 0. `GET /` → 200 + all headers. Wrong `Host` → 403 on every route. `POST /kill` with a foreign `Origin` → 403. Live orchestrator (pidfile of a live pid) → flag set; second call → "already requested". Unknown ID → 404; not live → 409; `resolving` → 409. A throwing handler → plain 500, no stack. Missing DB → the "start the daemon" page.
- `kill.test.ts`: each `requestKill()` branch, including launchd `running` with no pidfile → flag path. The existing `tests/cli-ops.test.ts` kill tests pass unchanged.
- Existing tests for `status()`, `blockIssue`, caps, queue, notify, rebase keep passing after the refactors.

## Delivery

- Worktree `.worktrees/dashboard` on branch `feat/dashboard`, cut from fresh `origin/main`; copy `.env`; `bun install` so the husky hook runs.
- First commit: this plan copied to `docs/dashboard_plan.md`.
- One PR, not merged by me.
- Follow-ups to note in the PR: claims stay `blocked` after Done (needs a cleanup in `sweepDone`); Kill cannot stop a resolver.

## Verification

1. `bun test`, `bun run typecheck`, `bun run lint`, `bun run check:size` — all green.
2. Real data, read-only: run `bin/marshall dashboard` from the worktree against the real `~/.marshall` (no migration in this PR, and the dashboard never migrates). Open `http://127.0.0.1:7474` in Chrome at 390 px and 1440 px, light and dark:
   - the strip shows the manual pause that has been on since 2026-09-30;
   - Needs-you cards match the issues that Linear lists as Needs Verification or Blocked (pick a real one at test time; TOD-15 is `released`, so it must not appear), and the 10 stale `blocked` rows do not appear;
   - a card's hand-off opens, has no visible `<!-- -->` header, and stays open across refreshes;
   - agent panels, idle slots, and the queue match `marshall status` and `marshall queue`;
   - `launchctl kill TERM` on the daemon (or `marshall stop`) shows "daemon down" within 5 s; `marshall start` brings it back.
3. Kill, without touching a real agent or real Linear: a temp `MARSHALL_HOME` with a seeded live claim (fake UUID), a pidfile holding a live pid (`sleep 3600 &`), and a temp config with another port. Tap Kill twice → the `kill:<uuid>` flag row exists. One tap → resets after 4 s, also across a refresh.
4. Security: `curl -H 'Host: evil.com'` → 403; `curl -X POST -H 'Origin: https://evil.com'` → 403; a fixture hand-off with `<script>` renders as text.
5. launchd, from the main checkout only (never from the worktree): after the PR merges, `scripts/install-launchd.sh dashboard`; `launchctl kickstart -k gui/$(id -u)/com.jacques.marshall-dashboard` restarts it; the page comes back; the daemon job is untouched.
6. Phone (needs Jacques): install Tailscale on the Mac and the iPhone, log in to the same account, turn on HTTPS certificates, run `tailscale serve --bg 7474`, and open `https://<mac>.<tailnet>.ts.net` on the phone. Check the layout, a hand-off, and a two-tap Kill on the temp-home setup. Confirm `tailscale serve` passes a `*.ts.net` Host header; if it does not, widen the allow-list to what it sends.
7. Clean up: stop every dashboard process, the `sleep` pid, and the temp-home server I started. The launchd dashboard job stays installed only if Jacques wants it.
