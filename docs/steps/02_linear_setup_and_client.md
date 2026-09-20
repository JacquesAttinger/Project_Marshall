# Step 02 — Linear Setup and Client

<!-- Last edited: 2026-09-19 21:05 CDT -->

**TLDR:** Make the ChessBuddy Linear workspace ready for robots, then write the one module that talks to Linear.
Find issues, claim them, move them, comment on them, file follow-ups.

## Goal

Every Linear read or write in Jarvis goes through one typed client, and the ChessBuddy workspace has the states and labels the loop needs.

## Depends on / parallel with

- Depends on: 01 (for the config and logger).
- Parallel with: 03, 04, 05.
- The workspace setup half has no code dependency and can be done by hand today.

## Spec references

Sections 5.1, 5.3, 6.5, 12 of `project_jarvis_plan.md`.
Workspace: `https://linear.app/chessbuddy`, team ChessBuddy, team id `91f682c4-ff2b-4fa3-a3d6-46c22ea3882d`.

## In scope

### Workspace setup (manual or scripted)

- Add workflow state **Needs Verification**, type `started`, positioned after In Progress.
- Add label `agent-filed`.
- Decide the `jarvis:<agent-id>` label convention (create on demand, or a label group).
- Connect the GitHub integration to the ChessBuddy repo. Confirm auto-linking by branch name and "PR merged → Done." Turn off "PR opened → In Progress" if it fights the claim step.
- Create a Linear API key for this workspace and store it outside the repo (for example `~/.claude/chessbuddy-linear-key`, matching the Hemut key file pattern).

### Client module `src/linear.ts`

- `listPickable()` — state type `unstarted`, assignee me, delegate null, not archived. Returns id, identifier, title, description, priority, labels, `gitBranchName`, createdAt, comments.
- `claim(issueId, agentId)` — one `issueUpdate` (delegate = me, state = In Progress, add `jarvis:<agent-id>` label), then re-read and return false if the delegate is not me.
- `setState(issueId, stateName)` — by name, resolving ids once and caching.
- `comment(issueId, markdown)`.
- `createFollowUp(originIssueId, {title, description})` — same team, label `agent-filed`, relation `related` to origin.
- `getIssue(issueId)` including the latest human comment (for bounces, step 08).
- Rate limit awareness: 2,500 req/h on an API key. Log the remaining budget from response headers.

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
- `src/linear.ts` with the functions above and typed responses.
- `tests/linear.test.ts` — integration test against the real workspace using one throwaway issue: create, claim, comment, move to Needs Verification, file a follow-up, verify the relation, archive.
- `docs/linear_setup.md` — a short record of what was configured and the ids.

## Acceptance criteria

- The integration test passes end to end and leaves no junk issues behind.
- `claim` returns false when the issue already has a delegate.
- `listPickable` does not return issues in Needs Verification, Done, or Canceled.

## Open questions for grilling

1. Linear MCP or raw GraphQL with the API key? The daemon runs headless, so raw GraphQL is simpler; the MCP is what the skills already use.
2. Should the claim also set `assignee`, or only `delegate`? Delegate keeps me as owner in the UI.
3. Keep "PR opened → In Progress" automation on, or off?
4. Where does the API key live: key file, macOS Keychain, or `.env`?
5. Should `createFollowUp` also set priority, or leave it unset for me to triage?
