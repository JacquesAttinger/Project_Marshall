// Last edited: 2026-09-20 15:30 CDT
// A fake `fetch` that plays Linear. Routes by GraphQL operationName, records every call,
// and sets the rate-limit headers on each response. Handlers return data, `graphqlErrors(...)`,
// or `httpStatus(...)`.

import type { RawIssue, RawIssueDetail, TeamMeta } from "../../src/linear/queries.ts";

const STATUS = Symbol("status");

export interface FakeCall {
  operationName: string;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
  query: string;
}

export type Handler = (variables: Record<string, unknown>, call: FakeCall) => unknown;

export interface FakeLinear {
  fetchImpl: typeof fetch;
  calls: FakeCall[];
  callsFor(operationName: string): FakeCall[];
  /** Remaining requests reported in the next response. Decrements by one per call. */
  remaining: number;
}

export const IDS = {
  viewer: "user-me",
  team: "team-test",
  todo: "state-todo",
  inProgress: "state-in-progress",
  needsVerification: "state-needs-verification",
  blocked: "state-blocked",
  done: "state-done",
  agentFiled: "label-agent-filed",
  marshall: "label-marshall",
  agent0: "label-agent-0",
  agent1: "label-agent-1",
  agent2: "label-agent-2",
} as const;

export const RESET_AT_MS = Date.UTC(2026, 8, 20, 4, 0, 0);

export function httpStatus(status: number, body: unknown = {}): unknown {
  return { [STATUS]: status, body };
}

export function graphqlErrors(...messages: string[]): unknown {
  return { errors: messages.map((message) => ({ message })) };
}

export const viewerData = () => ({
  viewer: { id: IDS.viewer, name: "Test User", organization: { urlKey: "chessbuddy" } },
});

export const fullTeamData = (): { team: TeamMeta } => ({
  team: {
    id: IDS.team,
    key: "CB",
    states: {
      nodes: [
        { id: IDS.todo, name: "Todo", type: "unstarted", position: 1 },
        { id: IDS.inProgress, name: "In Progress", type: "started", position: 2 },
        { id: IDS.needsVerification, name: "Needs Verification", type: "started", position: 2.5 },
        { id: IDS.blocked, name: "Blocked", type: "started", position: 2.75 },
        { id: IDS.done, name: "Done", type: "completed", position: 3 },
      ],
    },
    labels: {
      nodes: [
        { id: IDS.agentFiled, name: "agent-filed", isGroup: false, parent: null },
        { id: IDS.marshall, name: "marshall", isGroup: true, parent: null },
        {
          id: IDS.agent0,
          name: "agent-0",
          isGroup: false,
          parent: { id: IDS.marshall, name: "marshall" },
        },
        {
          id: IDS.agent1,
          name: "agent-1",
          isGroup: false,
          parent: { id: IDS.marshall, name: "marshall" },
        },
        {
          id: IDS.agent2,
          name: "agent-2",
          isGroup: false,
          parent: { id: IDS.marshall, name: "marshall" },
        },
      ],
    },
  },
});

export const agentLabelNode = (slot: 0 | 1 | 2) => ({
  id: [IDS.agent0, IDS.agent1, IDS.agent2][slot] as string,
  name: `agent-${slot}`,
  parent: { name: "marshall" },
});

export function rawIssue(overrides: Partial<RawIssue> = {}): RawIssue {
  return {
    id: "issue-1",
    identifier: "CB-1",
    title: "Fix the thing",
    description: "Details",
    priority: 2,
    url: "https://linear.app/chessbuddy/issue/CB-1",
    branchName: "cb-1-fix-the-thing",
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    state: { id: IDS.todo, name: "Todo", type: "unstarted" },
    labels: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

export function rawDetail(overrides: Partial<RawIssueDetail> = {}): RawIssueDetail {
  return {
    ...rawIssue(),
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    ...overrides,
  };
}

function defaultHandlers(): Record<string, Handler> {
  return {
    Viewer: viewerData,
    TeamMeta: fullTeamData,
    PickableIssues: () => ({ issues: { nodes: [] } }),
    IssueById: () => ({ issue: rawDetail() }),
    UpdateIssue: (vars) => ({ issueUpdate: { success: true, issue: { id: vars.id } } }),
    CreateComment: () => ({ commentCreate: { success: true, comment: { id: "comment-1" } } }),
    UpdateComment: (vars) => ({ commentUpdate: { success: true, comment: { id: vars.id } } }),
    CreateIssue: () => ({
      issueCreate: {
        success: true,
        issue: {
          id: "issue-new",
          identifier: "CB-99",
          url: "https://linear.app/chessbuddy/issue/CB-99",
        },
      },
    }),
    CreateRelation: () => ({ issueRelationCreate: { success: true } }),
    CreateState: () => ({
      workflowStateCreate: { success: true, workflowState: { id: "state-new" } },
    }),
    CreateLabel: (vars) => ({
      issueLabelCreate: {
        success: true,
        issueLabel: { id: `label-new-${(vars.input as { name: string }).name}` },
      },
    }),
    DeleteIssue: () => ({ issueDelete: { success: true } }),
  };
}

function isStatus(result: unknown): result is { [STATUS]: number; body: unknown } {
  return typeof result === "object" && result !== null && STATUS in result;
}

export function fakeLinear(handlers: Record<string, Handler> = {}): FakeLinear {
  const routes = { ...defaultHandlers(), ...handlers };
  const calls: FakeCall[] = [];
  const fake: FakeLinear = {
    calls,
    callsFor: (name) => calls.filter((c) => c.operationName === name),
    remaining: 2500,
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        operationName: string;
        variables: Record<string, unknown>;
      };
      const call: FakeCall = {
        operationName: body.operationName,
        variables: body.variables,
        headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
        query: body.query,
      };
      calls.push(call);
      fake.remaining -= 1;
      const headers = {
        "Content-Type": "application/json",
        "X-RateLimit-Requests-Limit": "2500",
        "X-RateLimit-Requests-Remaining": String(fake.remaining),
        "X-RateLimit-Requests-Reset": String(RESET_AT_MS),
      };
      const handler = routes[body.operationName];
      if (!handler) {
        return new Response(
          JSON.stringify(graphqlErrors(`No fake handler for ${body.operationName}`)),
          {
            status: 200,
            headers,
          },
        );
      }
      const result = handler(body.variables, call);
      if (isStatus(result)) {
        return new Response(JSON.stringify(result.body), { status: result[STATUS], headers });
      }
      if (typeof result === "object" && result !== null && "errors" in result) {
        return new Response(JSON.stringify(result), { status: 200, headers });
      }
      return new Response(JSON.stringify({ data: result }), { status: 200, headers });
    }) as typeof fetch,
  };
  return fake;
}
