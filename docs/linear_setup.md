# Linear setup for Marshall

<!-- Last edited: 2026-09-19 23:25 CDT -->

**TLDR:** Marshall talks to the ChessBuddy Linear workspace with a personal API key.
One command creates the state and labels the loop needs.
Two things stay manual: the API key and the GitHub integration.

## Workspace

| Item | Value |
|---|---|
| Workspace | `https://linear.app/chessbuddy` (`urlKey` = `chessbuddy`) |
| Team | ChessBuddy, id `91f682c4-ff2b-4fa3-a3d6-46c22ea3882d` (in `marshall.config.json`) |
| API key variable | `MARSHALL_LINEAR_API_KEY` in `.env` |

## Manual steps (once)

1. Create a personal API key in the ChessBuddy workspace: Settings → Security & access → Personal API keys.
2. Put it in `.env` as `MARSHALL_LINEAR_API_KEY=lin_api_...`.
   The name is not `LINEAR_API_KEY` on purpose.
   Bun keeps an exported shell variable over the same name in `.env`, and the shell already exports the Hemut `LINEAR_API_KEY`.
3. Connect the GitHub integration to `dvairus/ChessBuddy` (Settings → Integrations → GitHub).
   Keep the default automations on.
   Confirm "PR merged → Done" is on.
   "PR opened → In Progress" never fights the claim, because the claim moves the issue to In Progress before any PR exists.
4. Run `bin/marshall linear setup` (below).

## `marshall linear setup`

Idempotent.
Reads the team once, then creates only what is missing:

| Kind | Name | Type / parent | Purpose |
|---|---|---|---|
| Workflow state | `Needs Verification` | type `started`, color `#f2c94c`, positioned after In Progress | The agent is done; a human checks the PR |
| Label | `agent-filed` | team label | Follow-up issues Marshall files (spec §6.5) |
| Label group | `marshall` | `isGroup: true` | Holds one child per agent slot |
| Label | `marshall/agent-0`, `agent-1`, `agent-2` | children of `marshall` | The claim lock (see below) |

The command refuses to run when the key belongs to another workspace (exit 1, no writes).
`--json` prints the same report as JSON.

Run it a second time and every `created` flag is `false`.

### Recorded output

Not yet run against the real workspace.
When you run it, paste the output here so the ids are on record.

```
bin/marshall linear setup
```

## Conventions the client relies on

### Claim lock

Linear's `delegate` field only accepts agent users (the OAuth agent from iteration 2), so the lock is:

- State `In Progress` plus exactly one `marshall/agent-<slot>` label.
- `claim(issueId, agentId)`: read the issue; give up if it is not `unstarted` or any agent label is on it; one `issueUpdate` (state, add ours, remove the other agent labels); read again; return `true` only if the state is In Progress and our label is the only agent label.
- `release(issueId)`: state `Todo`, every agent label removed, optional comment.
- Pickable = state type `unstarted`, assignee me, in the ChessBuddy team.
  Needs Verification, Done, and Canceled are never pickable.

### Comment footer

Agents act as the same Linear user as the human, so every comment Marshall posts ends with `_— Marshall_`.
`getIssue().latestHumanComment` is the newest comment without that footer.
Do not end your own comments with it.

### Follow-ups

`createFollowUp` files in the same team, assigned to me, label `agent-filed`, no priority, default state (Todo), and a `related` relation back to the origin.
Follow-ups are pickable straight away; step 07 sorts No priority last so you can triage first.

### Rate budget

2,500 requests per hour per key.
Every call logs `linear.request` with the remaining budget; below 200 it logs `linear.budget_low` at warn.
A 429 is a `LinearRateLimitError` with `resetAt`.
The client does not retry; step 07's loop owns that.

## E2E test

```bash
MARSHALL_LINEAR_E2E=1 bun test tests/linear.e2e.test.ts
```

Runs against the real workspace with the key from `.env`.
Creates `[marshall e2e] <timestamp>` and one follow-up, walks the whole claim flow, and deletes both in `afterAll` (Linear's 30-day trash).
Without `MARSHALL_LINEAR_E2E=1` every e2e test is skipped, so `bun test` and CI never touch Linear.
