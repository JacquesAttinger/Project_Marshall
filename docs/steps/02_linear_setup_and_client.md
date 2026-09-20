# Step 02 — Linear Setup and Client

<!-- Last edited: 2026-09-19 23:30 CDT -->

**TLDR:** Make the ChessBuddy Linear workspace ready for robots, then write the one module that talks to Linear.
Find issues, claim them, move them, comment on them, file follow-ups.

## Goal

Every Linear read or write in Marshall goes through one typed client, and the ChessBuddy workspace has the states and labels the loop needs.

## Depends on / parallel with

- Depends on: 01 (for the config and logger).
- Parallel with: 03, 04, 05.
- The workspace setup half has no code dependency and can be done by hand today.

## Spec references

Sections 5.1, 5.3, 6.5, 12 of `project_marshall_plan.md`.
Workspace: `https://linear.app/chessbuddy`, team ChessBuddy, team id `91f682c4-ff2b-4fa3-a3d6-46c22ea3882d`.

## In scope

### Workspace setup (manual or scripted)

- `marshall linear setup` (scripted, idempotent) creates: workflow state **Needs Verification** (type `started`, after In Progress), label `agent-filed`, and the `marshall` label group with children `agent-0`, `agent-1`, `agent-2`.
- Manual: connect the GitHub integration to the ChessBuddy repo. Keep default automations. Confirm "PR merged → Done."
- Manual: create a personal API key in the ChessBuddy workspace and put it in `.env` as `MARSHALL_LINEAR_API_KEY`.

### Client module `src/linear/`

- `connectLinear({ apiKey, teamId, workspace, log })` — reads the viewer, throws `ConfigError` unless `organization.urlKey` equals `workspace`, loads team states and labels once, and throws with "run `marshall linear setup`" if any are missing.
- `listPickable()` — state type `unstarted`, assignee me, in the team, not archived. Returns id, identifier, title, description, priority, url, `branchName`, createdAt, labels, comments.
- `claim(issueId, agentId)` — pre-read (false if not `unstarted` or any `marshall/*` label is on it), one `issueUpdate` (state In Progress, add `marshall/agent-<slot>`, remove the other agent labels), re-read and return true only if our label is the only agent label.
- `release(issueId, { comment? })` — state Todo, every agent label removed, optional comment. Used by step 07 reconcile and step 08 bounces.
- `setState(issueId, stateName)` — by name, ids cached at connect.
- `comment(issueId, markdown)` — appends the `_— Marshall_` footer.
- `createFollowUp(originIssueId, {title, description})` — same team, assignee me, label `agent-filed`, no priority, relation `related` to origin.
- `getIssue(issueId)` — includes `state`, `agentId`, `latestHumanComment` (newest comment without the footer; for bounces, step 08), and `relatedIssueIds`.
- Rate limit awareness: 2,500 req/h on an API key. The remaining budget is logged from response headers on every call; 429 is a `LinearRateLimitError`. No retries here (step 07).

## Out of scope

- The poll loop and ordering. That is step 07.
- The Linear OAuth agent and webhooks. That is iteration 2.

## Reuse (search first)

- `~/.claude/hooks/session-start-linear-suggest.sh` — working GraphQL query for my open issues.
- `~/.claude/skills/linear-sync/SKILL.md` — state names and the PR-link pattern.
- `~/.claude/hooks/hemut-linear-guard.sh` — key file convention.
- The Linear MCP tools already loaded in the harness (`save_issue`, `save_comment`, `list_issue_statuses`) for one-off setup actions.

## Deliverables

- Workspace configured (state, labels, GitHub integration, API key).
- `src/linear/` (`gql.ts`, `queries.ts`, `map.ts`, `client.ts`, `setup.ts`) with the functions above and Zod-checked responses.
- `bin/marshall linear setup [--json]`.
- `tests/linear/*.test.ts` — fake-fetch unit tests, run in pre-commit and CI.
- `tests/linear.e2e.test.ts` — against the real workspace, only with `MARSHALL_LINEAR_E2E=1`: create, claim, second claim fails, comment, Needs Verification, follow-up with relation, release, delete.
- `docs/linear_setup.md` — a short record of what was configured and the ids.

## Acceptance criteria

- The e2e test passes end to end and leaves no junk issues behind.
- `claim` returns false when the issue already carries another agent's label or is not `unstarted`.
- `listPickable` does not return issues in Needs Verification, Done, or Canceled.
- `marshall linear setup` run twice creates nothing the second time.
- `connectLinear` refuses a key from any workspace but `chessbuddy`.

## Decisions (grilling session, 2026-09-19)

| # | Decision | Choice |
|---|---|---|
| 1 | API key | `MARSHALL_LINEAR_API_KEY` in `.env`. On connect, the client reads `viewer.organization.urlKey` and throws unless it equals `config.workspace`. Not `LINEAR_API_KEY`: the shell exports the Hemut key and Bun keeps an exported variable over `.env`. |
| 2 | Claim lock | State + label group, no delegate. `delegate` only accepts agent users, so it waits for the iteration 2 OAuth agent. |
| 3 | Workspace setup | Scripted, idempotent `marshall linear setup`. GitHub integration and the API key stay manual. |
| 4 | Transport | Raw GraphQL over `fetch`. Zero deps. `fetch` is injectable. Rate-limit headers logged on every call. |
| 5 | Tests | Fake-fetch unit tests in pre-commit and CI. The real-workspace test runs only with `MARSHALL_LINEAR_E2E=1`. |

## Decisions by recommendation

| # | Question | Choice and why |
|---|---|---|
| 6 | "PR opened → In Progress" automation | Keep defaults on. The claim moves the issue to In Progress before any PR exists. Confirm "PR merged → Done" is on. |
| 7 | Follow-up priority | Unset (No priority), assigned to me. Step 07 sorts No priority last, so you triage before they jump the queue. |
| 8 | Throwaway test issue cleanup | `issueDelete` (30-day trash), not archive. |
| 9 | `release()` | Added. Step 07 reconcile and step 08 bounces need "state → Todo, remove agent label, optional comment". |
| 10 | Telling my comments from Marshall's | Every `comment()` appends `_— Marshall_`. `latestHumanComment` is the newest comment without that footer. |
| 11 | Agent id | `agent-<slot>` (`agent-0`, `agent-1`, `agent-2`), matching `claims.slot`. `claim()` rejects any other id. |
| 12 | Team id | Hard-coded in `marshall.config.json`; `teamId` is `min(1)`. |
