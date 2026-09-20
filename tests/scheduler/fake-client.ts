// Last edited: 2026-09-20 16:20 CDT
// An in-memory LinearClient for scheduler tests. Keeps each issue's state and agent labels and
// applies the same claim rules as the real client (unstarted + no agent label = claimable).
// `tests/linear/fake-linear.ts` fakes the transport instead; this fakes the client.

import {
  agentLabelName,
  type IssueDetail,
  isAgentId,
  type LinearClient,
  MARSHALL_LABEL_GROUP,
  type PickableIssue,
} from "../../src/linear/index.ts";

export interface FakeIssue {
  issue: PickableIssue;
  state: { name: string; type: string };
  /** Full label names, `marshall/agent-0` style. */
  labels: string[];
}

export interface FakeCall {
  method: string;
  issueId: string;
  arg?: unknown;
}

export interface FakeLinearClient extends LinearClient {
  issues: Map<string, FakeIssue>;
  calls: FakeCall[];
  comments: { issueId: string; body: string }[];
  /** Make `claim` lose for these ids, as if another process took the lock in between. */
  loseClaims: Set<string>;
  stateOf(issueId: string): string;
  labelsOf(issueId: string): string[];
}

const STATE_TYPES: Record<string, string> = {
  Todo: "unstarted",
  "In Progress": "started",
  "Needs Verification": "started",
  Blocked: "started",
  Done: "completed",
};

function isAgentLabel(label: string): boolean {
  const [group, child] = label.split("/");
  return group === MARSHALL_LABEL_GROUP && child !== undefined && isAgentId(child);
}

let seq = 0;

export function pickable(overrides: Partial<PickableIssue> = {}): PickableIssue {
  seq += 1;
  const n = overrides.identifier?.replace(/\D/g, "") ?? String(seq);
  return {
    id: `issue-${n}`,
    identifier: `CB-${n}`,
    title: `Issue ${n}`,
    description: null,
    priority: 3,
    url: `https://linear.app/chessbuddy/issue/CB-${n}`,
    branchName: `cb-${n}-issue`,
    createdAt: `2026-09-${String(10 + (Number(n) % 20)).padStart(2, "0")}T00:00:00.000Z`,
    labels: [],
    comments: [],
    ...overrides,
  };
}

export function fakeClient(issues: PickableIssue[] = []): FakeLinearClient {
  const map = new Map<string, FakeIssue>();
  for (const issue of issues) {
    map.set(issue.id, { issue, state: { name: "Todo", type: "unstarted" }, labels: [] });
  }
  const calls: FakeCall[] = [];
  const comments: { issueId: string; body: string }[] = [];
  const get = (id: string): FakeIssue => {
    const found = map.get(id);
    if (!found) throw new Error(`fake linear: unknown issue ${id}`);
    return found;
  };
  const client: FakeLinearClient = {
    issues: map,
    calls,
    comments,
    loseClaims: new Set(),
    stateOf: (id) => get(id).state.name,
    labelsOf: (id) => get(id).labels,
    whoami: () => ({ userId: "user-me", name: "Test User", workspace: "chessbuddy" }),
    budget: () => null,
    async listPickable() {
      calls.push({ method: "listPickable", issueId: "" });
      return [...map.values()].filter((i) => i.state.type === "unstarted").map((i) => i.issue);
    },
    async claim(issueId, agentId) {
      calls.push({ method: "claim", issueId, arg: agentId });
      const entry = get(issueId);
      const holders = entry.labels.filter(isAgentLabel);
      if (entry.state.type !== "unstarted" || holders.length > 0) return false;
      if (client.loseClaims.has(issueId)) return false;
      entry.state = { name: "In Progress", type: "started" };
      entry.labels = [...entry.labels.filter((l) => !isAgentLabel(l)), agentLabelName(agentId)];
      return true;
    },
    async release(issueId, opts = {}) {
      calls.push({ method: "release", issueId, arg: opts.comment });
      const entry = get(issueId);
      entry.state = { name: "Todo", type: "unstarted" };
      entry.labels = entry.labels.filter((l) => !isAgentLabel(l));
      if (opts.comment) comments.push({ issueId, body: opts.comment });
    },
    async setState(issueId, stateName) {
      calls.push({ method: "setState", issueId, arg: stateName });
      const type = STATE_TYPES[stateName];
      if (!type) throw new Error(`Unknown workflow state "${stateName}"`);
      get(issueId).state = { name: stateName, type };
    },
    async comment(issueId, markdown) {
      calls.push({ method: "comment", issueId, arg: markdown });
      comments.push({ issueId, body: markdown });
    },
    async createFollowUp() {
      throw new Error("fake linear: createFollowUp is not part of the scheduler");
    },
    async getIssue(issueId): Promise<IssueDetail> {
      const entry = get(issueId);
      const agent = entry.labels.find(isAgentLabel)?.split("/")[1];
      return {
        ...entry.issue,
        labels: entry.labels,
        state: entry.state,
        agentId: agent && isAgentId(agent) ? agent : null,
        latestHumanComment: null,
        relatedIssueIds: [],
      };
    },
  };
  return client;
}
