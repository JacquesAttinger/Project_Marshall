// Last edited: 2026-09-19 22:20 CDT
// The one module that talks to Linear. Every read or write Marshall makes goes through LinearClient.
// Claim lock = state In Progress + one `marshall/agent-<slot>` label. `delegate` waits for the
// iteration 2 OAuth agent, because the API only accepts agent users there.

import { ConfigError } from "../config.ts";
import type { Logger } from "../log.ts";
import { createGql, type Gql, LinearError, type RateBudget } from "./gql.ts";
import {
  AGENT_FILED_LABEL,
  AGENT_IDS,
  type AgentId,
  agentLabelName,
  agentLabelsOf,
  IN_PROGRESS_STATE,
  type IssueDetail,
  isAgentId,
  MARSHALL_COMMENT_FOOTER,
  NEEDS_VERIFICATION_STATE,
  type PickableIssue,
  TODO_STATE,
  toDetail,
  toPickable,
} from "./map.ts";
import {
  CreateComment,
  CreateIssue,
  CreateRelation,
  IssueById,
  type Operation,
  PickableIssues,
  type TeamMeta,
  TeamMetaOp,
  UpdateIssue,
  Viewer,
} from "./queries.ts";

export interface ViewerInfo {
  userId: string;
  name: string;
  workspace: string;
}

export interface FollowUpInput {
  title: string;
  description: string;
}

export interface CreatedIssue {
  id: string;
  identifier: string;
  url: string;
}

export interface LinearClient {
  whoami(): ViewerInfo;
  budget(): RateBudget | null;
  listPickable(): Promise<PickableIssue[]>;
  /** True only when this call took the lock. False if someone else holds it or the state moved. */
  claim(issueId: string, agentId: AgentId): Promise<boolean>;
  /** Back to Todo with every agent label removed. Used by reconcile (07) and bounces (08). */
  release(issueId: string, opts?: { comment?: string }): Promise<void>;
  setState(issueId: string, stateName: string): Promise<void>;
  comment(issueId: string, markdown: string): Promise<void>;
  createFollowUp(originIssueId: string, input: FollowUpInput): Promise<CreatedIssue>;
  getIssue(issueId: string): Promise<IssueDetail>;
}

export interface ConnectOptions {
  apiKey: string;
  teamId: string;
  workspace: string;
  log: Logger;
  fetchImpl?: typeof fetch;
}

/** Run one operation. Small wrapper so call sites read as `run(gql, Op, vars)`. */
export function run<T>(gql: Gql, op: Operation<T>, variables: object = {}): Promise<T> {
  return gql(op.doc, op.name, variables, op.schema);
}

/** Read the viewer and refuse to continue unless the key belongs to the configured workspace. */
export async function verifyWorkspace(gql: Gql, workspace: string): Promise<ViewerInfo> {
  const { viewer } = await run(gql, Viewer);
  const actual = viewer.organization.urlKey;
  if (actual !== workspace) {
    throw new ConfigError(
      `MARSHALL_LINEAR_API_KEY belongs to workspace "${actual}" but marshall.config.json says "${workspace}". Refusing to continue.`,
    );
  }
  return { userId: viewer.id, name: viewer.name, workspace: actual };
}

export interface TeamIndex {
  stateIds: Map<string, string>;
  labelIds: Map<string, string>;
}

/** Index a team's states and labels by name. Group children are keyed as `group/child`. */
export function indexTeam(team: TeamMeta): TeamIndex {
  const stateIds = new Map(team.states.nodes.map((s) => [s.name, s.id]));
  const labelIds = new Map(
    team.labels.nodes.map((l) => [l.parent ? `${l.parent.name}/${l.name}` : l.name, l.id]),
  );
  return { stateIds, labelIds };
}

function requireSetup(index: TeamIndex): void {
  const missing: string[] = [];
  for (const name of [TODO_STATE, IN_PROGRESS_STATE, NEEDS_VERIFICATION_STATE]) {
    if (!index.stateIds.has(name)) missing.push(`state "${name}"`);
  }
  for (const name of [AGENT_FILED_LABEL, ...AGENT_IDS.map(agentLabelName)]) {
    if (!index.labelIds.has(name)) missing.push(`label "${name}"`);
  }
  if (missing.length > 0) {
    throw new LinearError(
      `Linear team is missing ${missing.join(", ")}. Run \`marshall linear setup\`.`,
      TeamMetaOp.name,
    );
  }
}

/** Everything a bound client method needs. Built once by connectLinear. */
interface Ctx {
  gql: Gql;
  teamId: string;
  viewer: ViewerInfo;
  log: Logger;
  stateId(name: string): string;
  labelId(name: string): string;
  agentLabelIds: string[];
}

async function comment(ctx: Ctx, issueId: string, markdown: string): Promise<void> {
  await run(ctx.gql, CreateComment, {
    input: { issueId, body: `${markdown}${MARSHALL_COMMENT_FOOTER}` },
  });
}

async function claim(ctx: Ctx, issueId: string, agentId: AgentId): Promise<boolean> {
  if (!isAgentId(agentId)) throw new Error(`Unknown agent id: ${agentId}`);
  const before = (await run(ctx.gql, IssueById, { id: issueId })).issue;
  const holders = agentLabelsOf(before.labels.nodes);
  if (before.state.type !== "unstarted" || holders.length > 0) {
    ctx.log.info("linear.claim_skipped", { issueId, agentId, state: before.state.name, holders });
    return false;
  }
  const ours = ctx.labelId(agentLabelName(agentId));
  await run(ctx.gql, UpdateIssue, {
    id: issueId,
    input: {
      stateId: ctx.stateId(IN_PROGRESS_STATE),
      addedLabelIds: [ours],
      removedLabelIds: ctx.agentLabelIds.filter((id) => id !== ours),
    },
  });
  const after = (await run(ctx.gql, IssueById, { id: issueId })).issue;
  const afterHolders = agentLabelsOf(after.labels.nodes);
  const won = after.state.name === IN_PROGRESS_STATE && afterHolders.join() === agentId;
  ctx.log.info(won ? "linear.claimed" : "linear.claim_lost", {
    issueId,
    agentId,
    state: after.state.name,
    holders: afterHolders,
  });
  return won;
}

async function release(ctx: Ctx, issueId: string, opts: { comment?: string } = {}): Promise<void> {
  await run(ctx.gql, UpdateIssue, {
    id: issueId,
    input: { stateId: ctx.stateId(TODO_STATE), removedLabelIds: ctx.agentLabelIds },
  });
  ctx.log.info("linear.released", { issueId });
  if (opts.comment) await comment(ctx, issueId, opts.comment);
}

async function createFollowUp(
  ctx: Ctx,
  originId: string,
  input: FollowUpInput,
): Promise<CreatedIssue> {
  const { issueCreate } = await run(ctx.gql, CreateIssue, {
    input: {
      teamId: ctx.teamId,
      title: input.title,
      description: input.description,
      assigneeId: ctx.viewer.userId,
      labelIds: [ctx.labelId(AGENT_FILED_LABEL)],
    },
  });
  const created = issueCreate.issue;
  await run(ctx.gql, CreateRelation, {
    input: { issueId: created.id, relatedIssueId: originId, type: "related" },
  });
  ctx.log.info("linear.follow_up_filed", {
    originId,
    issueId: created.id,
    identifier: created.identifier,
  });
  return created;
}

function buildClient(ctx: Ctx): LinearClient {
  return {
    whoami: () => ctx.viewer,
    budget: () => ctx.gql.lastBudget,
    listPickable: async () => {
      const { issues } = await run(ctx.gql, PickableIssues, {
        teamId: ctx.teamId,
        assigneeId: ctx.viewer.userId,
      });
      return issues.nodes.map(toPickable);
    },
    claim: (issueId, agentId) => claim(ctx, issueId, agentId),
    release: (issueId, opts) => release(ctx, issueId, opts),
    setState: async (issueId, stateName) => {
      await run(ctx.gql, UpdateIssue, { id: issueId, input: { stateId: ctx.stateId(stateName) } });
      ctx.log.info("linear.state_set", { issueId, state: stateName });
    },
    comment: (issueId, markdown) => comment(ctx, issueId, markdown),
    createFollowUp: (originId, input) => createFollowUp(ctx, originId, input),
    getIssue: async (issueId) => toDetail((await run(ctx.gql, IssueById, { id: issueId })).issue),
  };
}

/** Verify the workspace, load team metadata once, and return a client bound to that team. */
export async function connectLinear(opts: ConnectOptions): Promise<LinearClient> {
  const gql = createGql({ apiKey: opts.apiKey, log: opts.log, fetchImpl: opts.fetchImpl });
  const viewer = await verifyWorkspace(gql, opts.workspace);
  const { team } = await run(gql, TeamMetaOp, { id: opts.teamId });
  const index = indexTeam(team);
  requireSetup(index);
  const stateId = (name: string): string => {
    const id = index.stateIds.get(name);
    if (!id) throw new LinearError(`Unknown workflow state "${name}"`, UpdateIssue.name);
    return id;
  };
  // requireSetup already proved every label this client asks for exists.
  const labelId = (name: string): string => index.labelIds.get(name) as string;
  return buildClient({
    gql,
    teamId: opts.teamId,
    viewer,
    log: opts.log.child({ team: team.key }),
    stateId,
    labelId,
    agentLabelIds: AGENT_IDS.map((a) => labelId(agentLabelName(a))),
  });
}
