# Step 02 — Linear Setup and Client: Implementation Plan

<!-- Last edited: 2026-09-19 22:05 CDT -->

## TLDR

Marshall needs one module that talks to Linear: find my Todo issues, claim one, move it, comment on it, and file follow-up issues.
This step builds that module for the ChessBuddy workspace, plus a `marshall linear setup` command that creates the custom state and labels the loop needs.
Two things changed from the step file.
Linear's `delegate` field only accepts agent users, so the claim lock is now "state In Progress + a `marshall` label" instead.
Your shell already exports the Hemut `LINEAR_API_KEY`, and Bun will not let `.env` override it, so the key is renamed to `MARSHALL_LINEAR_API_KEY` and the client refuses to run against any workspace but `chessbuddy`.

## Context

`docs/steps/02_linear_setup_and_client.md` is wave 2 of iteration 1.
Steps 06, 07, and 08 import its client.
Step 01 (scaffold) is merged as PR #2 (`origin/main` at `f6366ec`).
The step file had five open questions.
Five higher-leverage questions were answered in a grilling session on 2026-09-19.
The rest are decided by recommendation below (question cap reached).

## Decisions (from grilling)

| # | Decision | Choice |
|---|---|---|
| 1 | API key | `MARSHALL_LINEAR_API_KEY` in `.env`. On connect, the client reads `viewer.organization.urlKey` and throws unless it equals `config.workspace`. |
| 2 | Claim lock | State + label group, no delegate. `claim()` = pre-read, one `issueUpdate` (state In Progress, add `marshall/agent-<slot>`, remove other agent labels), re-read. Pickable = state type `unstarted`, assignee me. `delegate` waits for the iteration 2 OAuth agent. |
| 3 | Workspace setup | Scripted, idempotent `marshall linear setup`. Creates the Needs Verification state, the `agent-filed` label, and the `marshall` label group with `agent-0`, `agent-1`, `agent-2`. GitHub integration and the API key stay manual. |
| 4 | Transport | Raw GraphQL over `fetch`. Zero deps. `fetch` is injectable. Rate-limit headers logged on every call. |
| 5 | Tests | Fake-fetch unit tests run in pre-commit and CI. The real-workspace test runs only with `MARSHALL_LINEAR_E2E=1`. |

## Decisions by recommendation (cap reached, not asked)

| # | Question | Choice and why |
|---|---|---|
| 6 | "PR opened → In Progress" automation | Keep Linear's defaults on. The claim moves the issue to In Progress before any PR exists, so the automation never fights it. Confirm "PR merged → Done" is on. |
| 7 | Follow-up priority | Leave unset (No priority). Step 07 sorts No priority last, so you triage before they jump the queue. Follow-ups are assigned to me, otherwise they are not pickable (spec §6.5 says they must be). |
| 8 | Throwaway test issue cleanup | `issueDelete` (30-day trash), not archive. Archive keeps junk visible forever. |
| 9 | `release()` | Added to the client. Step 07 reconcile and step 08 bounces need "state → Todo, remove agent label, optional comment". The step file did not list it. |
| 10 | Telling my comments from Marshall's | Agents act as me, so `Comment.user` is the same on both. Every `comment()` appends the footer `_— Marshall_`. `getIssue().latestHumanComment` is the newest comment without that footer. |
| 11 | Agent id | `agent-<slot>` (`agent-0`, `agent-1`, `agent-2`). Matches `claims.slot` from step 01. `claim()` rejects any other id. |
| 12 | Team id | Hard-code `91f682c4-ff2b-4fa3-a3d6-46c22ea3882d` in `marshall.config.json`. Tighten `teamId` to `min(1)`. |

## Facts verified

- Linear schema (public `schema.graphql`): `IssueUpdateInput.delegateId` is "the identifier of the agent user". `Issue.delegate` is "the agent user". `addedLabelIds` and `removedLabelIds` exist on `IssueUpdateInput`. `IssueFilter.state.type` is a `StringComparator`. `IssueLabelCreateInput` has `isGroup` and `parentId`. `WorkflowStateCreateInput` needs `teamId`, `name`, `type`, `color`; `position` is a Float. `IssueRelationCreateInput.type` is `related`. `issueDelete` moves to a 30-day trash.
- Rate limits (linear.app/developers/rate-limiting): 2,500 requests/hour per API key. Headers: `X-RateLimit-Requests-Limit`, `-Remaining`, `-Reset` (epoch ms).
- Bun keeps an exported shell variable over the same name in `.env`. Tested in the scratchpad: with `LINEAR_API_KEY` exported, a `.env` value is ignored.
- Local `main` is at `a57c113`; `origin/main` is at `f6366ec` (step 01 merged). The `rename-to-marshall` branch is merged and idle.
- Scaffold surface to reuse: `loadConfig`/`loadEnv`/`ConfigError` (`src/config.ts`), `createLogger` (`src/log.ts`), `dispatch`/`parseArgs` (`src/cli/index.ts`), `useTempHome`/`useTempConfig` (`tests/helpers.ts`), `scripts/check-size.ts` limits (500 lines/file, 75/function).
- The Linear MCP tools cannot be used from a Bun daemon. Raw GraphQL is the only option for code.

## Pre-flight (first actions after approval)

1. Copy this plan to `docs/step_02_linear_plan.md` in the worktree.
2. `git fetch origin` and fast-forward local `main` to `origin/main` (`f6366ec`).
3. `git worktree add .worktrees/step-02-linear -b feat/step-02-linear origin/main`. `.worktrees/` is already gitignored. There is no `.env` at the repo root yet, so nothing to copy.
4. `bun install` in the worktree.
5. Ask you for the ChessBuddy API key only when the unit tests are green and the e2e test is next. Unit work does not need it.

## Layout

```
src/
├── config.ts                    # EnvSchema: MARSHALL_LINEAR_API_KEY; teamId min(1); requireLinearApiKey()
├── linear/
│   ├── gql.ts                   # gql() transport: auth, errors, rate-limit headers, injectable fetch
│   ├── queries.ts               # GraphQL documents + Zod response schemas
│   ├── client.ts                # LinearClient interface + connectLinear()
│   ├── setup.ts                 # ensureWorkspaceSetup(): idempotent state + labels
│   └── index.ts                 # re-exports
└── cli/
    ├── index.ts                 # + `linear setup`
    └── linear.ts                # runLinearSetup()
tests/
├── helpers.ts                   # useTempConfig adds teamId
├── linear/
│   ├── fake-linear.ts           # fake fetch routed by operationName; records calls
│   ├── gql.test.ts
│   ├── client.test.ts
│   └── setup.test.ts
└── linear.e2e.test.ts           # skipIf(!MARSHALL_LINEAR_E2E)
docs/
├── linear_setup.md              # what is configured, ids, manual steps
├── step_02_linear_plan.md       # this plan
├── project_marshall_plan.md     # §5.3, §12 amended
└── steps/02_..., 07_...         # decisions recorded; "clear the delegate" → release()
marshall.config.json             # teamId filled
.env.example                     # MARSHALL_LINEAR_API_KEY
README.md                        # new command
```

Every new source file starts with `// Last edited: YYYY-MM-DD HH:MM CDT`.

## Files and behavior

### `src/config.ts`

- `EnvSchema`: replace `LINEAR_API_KEY` with `MARSHALL_LINEAR_API_KEY: z.string().optional()`. `NTFY_TOPIC_PREFIX` unchanged.
- `teamId: z.string().min(1)` (drop the empty default; the step 01 comment said step 02 tightens it).
- `requireLinearApiKey(env: Env): string` throws `ConfigError("MARSHALL_LINEAR_API_KEY is not set. Add it to .env (see .env.example).")`.
- `tests/helpers.ts` `useTempConfig` adds `teamId: "team-test"` so existing tests keep passing.

### `src/linear/gql.ts`

```ts
export interface GqlOptions { apiKey: string; fetchImpl?: typeof fetch; log: Logger; endpoint?: string }
export interface RateBudget { limit: number; remaining: number; resetAt: string }
export class LinearError extends Error { operation; status?; errors? }
export class LinearRateLimitError extends LinearError { resetAt: string }
export function createGql(opts): <T>(doc: string, operationName: string, variables: object, schema: ZodType<T>) => Promise<T>
```

- POST `https://api.linear.app/graphql`, `Authorization: <key>`, body `{ query, operationName, variables }`.
- Reads the three `X-RateLimit-Requests-*` headers into `RateBudget`, exposed as `gql.lastBudget`. Logs `linear.request` (debug) with `operation`, `ms`, `remaining`. Logs `linear.budget_low` (warn) when remaining < 200.
- HTTP 429 → `LinearRateLimitError`. `errors[]` in the body → `LinearError` with the messages. Response `data` is parsed with the given Zod schema; a mismatch is a `LinearError` naming the operation.
- No retries. Step 07's poll loop owns retry timing.

### `src/linear/queries.ts`

One exported `{ doc, name, schema }` per operation. Shared fragment `IssueFields`: `id identifier title description priority url branchName createdAt updatedAt state { id name type } labels { nodes { id name parent { name } } } comments(last: 25) { nodes { id body createdAt } }`.

| Name | Operation |
|---|---|
| `Viewer` | `viewer { id name organization { urlKey } }` |
| `TeamMeta` | `team(id) { id key states { nodes { id name type position } } labels { nodes { id name isGroup parent { id name } } } }` |
| `PickableIssues` | `issues(filter: { team: { id: { eq } }, assignee: { id: { eq } }, state: { type: { eq: "unstarted" } } }, first: 50) { nodes { ...IssueFields } }` |
| `IssueById` | `issue(id) { ...IssueFields relations { nodes { type relatedIssue { id } } } }` |
| `UpdateIssue` | `issueUpdate(id, input) { success issue { id } }` — used by claim, release, setState |
| `CreateComment` | `commentCreate(input: { issueId, body }) { success }` |
| `CreateIssue` | `issueCreate(input) { success issue { id identifier url } }` |
| `CreateRelation` | `issueRelationCreate(input: { issueId, relatedIssueId, type: related }) { success }` |
| `CreateState` | `workflowStateCreate(input) { success workflowState { id } }` |
| `CreateLabel` | `issueLabelCreate(input) { success issueLabel { id } }` |
| `DeleteIssue` | `issueDelete(id) { success }` — e2e cleanup only |

Archived issues are excluded by default, so no `includeArchived` flag is needed.

### `src/linear/client.ts`

```ts
export const AGENT_IDS = ["agent-0", "agent-1", "agent-2"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const MARSHALL_COMMENT_FOOTER = "\n\n_— Marshall_";

export interface IssueComment { id; body; createdAt; fromMarshall: boolean }
export interface PickableIssue { id; identifier; title; description: string | null; priority; url; branchName; createdAt; labels: string[]; comments: IssueComment[] }
export interface IssueDetail extends PickableIssue { state: { name; type }; agentId: AgentId | null; latestHumanComment: IssueComment | null; relatedIssueIds: string[] }

export interface LinearClient {
  whoami(): { userId: string; name: string; workspace: string };
  budget(): RateBudget | null;
  listPickable(): Promise<PickableIssue[]>;
  claim(issueId: string, agentId: AgentId): Promise<boolean>;
  release(issueId: string, opts?: { comment?: string }): Promise<void>;
  setState(issueId: string, stateName: string): Promise<void>;
  comment(issueId: string, markdown: string): Promise<void>;
  createFollowUp(originIssueId: string, input: { title: string; description: string }): Promise<{ id; identifier; url }>;
  getIssue(issueId: string): Promise<IssueDetail>;
}

export async function connectLinear(opts: { apiKey; teamId; workspace; log; fetchImpl? }): Promise<LinearClient>
```

- `connectLinear` runs `Viewer`, throws `ConfigError` if `organization.urlKey !== workspace` (message names both), then loads `TeamMeta` once and caches state ids by name and label ids by name (children keyed as `marshall/agent-0`). Throws `LinearError` if `Needs Verification` or the labels are missing, with "run `marshall linear setup`" in the message.
- `claim`: (1) `IssueById`; return `false` if `state.type !== "unstarted"` or any `marshall/*` label is present. (2) `UpdateIssue` with `stateId = In Progress`, `addedLabelIds = [ours]`, `removedLabelIds = other agent labels`. (3) `IssueById` again; return `true` only if state is In Progress and our label is the only agent label. Three requests; claims are rare (≤ 6/day).
- `release`: `UpdateIssue` with `stateId = Todo`, `removedLabelIds = all agent labels`; then `comment()` if given.
- `setState`: name → cached id; unknown name is a `LinearError`.
- `comment`: appends `MARSHALL_COMMENT_FOOTER`.
- `createFollowUp`: `CreateIssue` with `teamId`, `assigneeId = viewer`, `labelIds = [agent-filed]`, no priority, no state (team default = Todo); then `CreateRelation`. Returns the new issue.
- `getIssue`: maps `IssueFields`; `fromMarshall = body.endsWith(footer)`; `latestHumanComment` = newest with `fromMarshall === false`; `agentId` from the `marshall/*` label.
- Pure mapping helpers (`toPickable`, `toDetail`, `agentLabelOf`) live at module scope so tests can hit them without fetch.
- Keep `client.ts` under 300 lines; if the mappers push it past that, move them to `src/linear/map.ts`.

### `src/linear/setup.ts`

```ts
export interface SetupResult { needsVerification: Ensured; agentFiled: Ensured; marshallGroup: Ensured; agents: Ensured[] }
interface Ensured { id: string; name: string; created: boolean }
export async function ensureWorkspaceSetup(gql, teamId, log): Promise<SetupResult>
```

- Reads `TeamMeta` once, then creates only what is missing.
- Needs Verification: `type: "started"`, `color: "#f2c94c"`, `position` = midway between In Progress and the next state (or In Progress + 1).
- `agent-filed`: plain team label.
- `marshall`: `isGroup: true`; children `agent-0..2` with `parentId`.
- Second run creates nothing (asserted in tests).

### `src/cli/linear.ts` and `src/cli/index.ts`

- `marshall linear setup [--json]`: `loadConfig` → `loadEnv` → `requireLinearApiKey` → `connectLinear` (guard) → `ensureWorkspaceSetup` → print a table of names, ids, and `created` flags, plus the remaining rate budget. Exit 1 with the `ConfigError` message on a wrong workspace.
- Add `linear setup` to `USAGE` and `dispatch`. If `dispatch` passes 75 lines, replace the `if` chain with a command table.

### Tests

`tests/linear/fake-linear.ts`: `fakeLinear(handlers: Record<operationName, (vars) => data | { errors } | { status: 429 }>)` returns `{ fetchImpl, calls }`. It sets the rate-limit headers on every response. Default handlers return a viewer in `chessbuddy`, a team with Todo / In Progress / Needs Verification / Done, and the three labels.

- `gql.test.ts`: sends the Authorization header and `operationName`; parses `RateBudget`; `errors[]` → `LinearError`; 429 → `LinearRateLimitError`; Zod mismatch names the operation.
- `client.test.ts`: guard throws on `urlKey: "hemut"` and names both workspaces; `listPickable` sends `teamId`, viewer id, and `unstarted`; `claim` returns `false` on a started state, on a foreign agent label, and on a mismatched re-read, and sends the right `addedLabelIds`/`removedLabelIds`; `release` sends Todo + all agent labels removed; `comment` appends the footer; `getIssue` skips footer comments for `latestHumanComment`; `createFollowUp` sets assignee, `agent-filed`, and then the `related` relation.
- `setup.test.ts`: nothing present → 1 state + 1 label + 1 group + 3 children; everything present → zero mutations; partial → only the missing ones.
- `linear.e2e.test.ts` (`describe.skipIf(!process.env.MARSHALL_LINEAR_E2E)`), in order, sharing one client:
  1. `connectLinear` passes the guard.
  2. `ensureWorkspaceSetup` twice; second result has `created: false` everywhere.
  3. Create `[marshall e2e] <ISO timestamp>` in Todo assigned to me → present in `listPickable`.
  4. `claim(id, "agent-0")` → `true`; absent from `listPickable`; `getIssue` shows In Progress and `agentId: "agent-0"`.
  5. `claim(id, "agent-1")` → `false`; label still `agent-0`.
  6. `comment` → `getIssue` has one comment with `fromMarshall: true`, `latestHumanComment: null`.
  7. `setState("Needs Verification")` → state type `started`; absent from `listPickable`.
  8. `createFollowUp` → new issue has `agent-filed`, assignee me, and `relatedIssueIds` contains the origin.
  9. `release(id)` → Todo, `agentId: null`; back in `listPickable`.
  10. `afterAll`: `DeleteIssue` on both; neither in `listPickable`. Runs even if a step fails.

### Docs

- `docs/linear_setup.md`: manual steps (create the API key in the ChessBuddy workspace under Settings → Security & access → Personal API keys; put it in `.env`; connect the GitHub integration to `dvairus/ChessBuddy`; keep default automations; confirm "PR merged → Done"), the `marshall linear setup` output with ids, the label and comment-footer conventions, and how to run the e2e test.
- `docs/steps/02_linear_setup_and_client.md`: replace "Open questions" with the decisions tables above; add `release()` to scope.
- `docs/project_marshall_plan.md`: §5.3 steps 1, 5, 6 (no delegate; state + label; pre-read); §12 "Claim lock" row → "Linear state + `marshall` label group + local SQLite"; §15 "Still open" gains "delegate once the OAuth agent exists (iteration 2)".
- `docs/steps/07_queue_and_scheduler.md`: reconcile line "clear the delegate and move the issue back to Todo" → "call `linear.release()`"; pickup filter text.
- `README.md`: add the command and the env var.
- `.env.example`: `MARSHALL_LINEAR_API_KEY=` with a one-line comment about the Hemut collision.

## Out of scope

- The poll loop, ordering, caps, and worktrees (step 07).
- Posting the hand-off package (step 06).
- Webhooks and the OAuth agent (iteration 2).
- Retry and back-off policy (step 07 owns the loop).

## Verification

1. `bun run lint && bun run typecheck && bun run check:size && bun test` in the worktree: green, e2e skipped.
2. You create the ChessBuddy API key and put it in `.env` as `MARSHALL_LINEAR_API_KEY`.
3. `bin/marshall linear setup` prints the ids; run it again and every `created` is `false`. Record the output in `docs/linear_setup.md`.
4. `bin/marshall linear setup --config <path-with-workspace-hemut>` exits 1 with the workspace mismatch message (guard check, no writes).
5. `MARSHALL_LINEAR_E2E=1 bun test tests/linear.e2e.test.ts` passes and leaves no issue behind (check the ChessBuddy board and the trash).
6. Open the ChessBuddy board once: Needs Verification sits after In Progress; the `marshall` group shows three children.
7. Commit through the pre-commit hook, push, open PR `feat/step-02-linear` → `main` with a concise description. Do not merge.
8. Kill nothing: this step starts no servers.
