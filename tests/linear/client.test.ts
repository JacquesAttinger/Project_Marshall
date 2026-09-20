// Last edited: 2026-09-19 22:55 CDT

import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../src/config.ts";
import { connectLinear } from "../../src/linear/client.ts";
import { LinearError } from "../../src/linear/gql.ts";
import {
  agentLabelOf,
  agentLabelsOf,
  isFromMarshall,
  MARSHALL_COMMENT_FOOTER,
  toDetail,
  toPickable,
} from "../../src/linear/map.ts";
import { recordingLogger } from "../helpers.ts";
import {
  agentLabelNode,
  fakeLinear,
  fullTeamData,
  type Handler,
  IDS,
  rawDetail,
  rawIssue,
} from "./fake-linear.ts";

async function connect(handlers: Record<string, Handler> = {}) {
  const fake = fakeLinear(handlers);
  const { log, lines } = recordingLogger();
  const client = await connectLinear({
    apiKey: "lin_test",
    teamId: IDS.team,
    workspace: "chessbuddy",
    log,
    fetchImpl: fake.fetchImpl,
  });
  return { fake, client, lines };
}

const inProgress = { id: IDS.inProgress, name: "In Progress", type: "started" };

/** IssueById handler: a fresh Todo issue on the first read, `after` on every later read. */
function readsThen(after: ReturnType<typeof rawDetail>): Handler {
  let reads = 0;
  return () => {
    reads += 1;
    return { issue: reads === 1 ? rawDetail() : after };
  };
}

describe("connectLinear", () => {
  test("loads the viewer and team once and exposes whoami", async () => {
    const { fake, client } = await connect();
    expect(client.whoami()).toEqual({
      userId: IDS.viewer,
      name: "Test User",
      workspace: "chessbuddy",
    });
    expect(fake.calls.map((c) => c.operationName)).toEqual(["Viewer", "TeamMeta"]);
    expect(fake.callsFor("TeamMeta")[0]?.variables).toEqual({ id: IDS.team });
    expect(client.budget()?.remaining).toBe(2498);
  });

  test("refuses a key from another workspace and names both", async () => {
    const promise = connect({
      Viewer: () => ({
        viewer: { id: "u", name: "Hemut Me", organization: { urlKey: "hemut" } },
      }),
    });
    await expect(promise).rejects.toBeInstanceOf(ConfigError);
    await expect(promise).rejects.toThrow(/"hemut".*"chessbuddy"/);
  });

  test("the guard runs before the team is read", async () => {
    const fake = fakeLinear({
      Viewer: () => ({ viewer: { id: "u", name: "x", organization: { urlKey: "hemut" } } }),
    });
    await connectLinear({
      apiKey: "k",
      teamId: IDS.team,
      workspace: "chessbuddy",
      log: recordingLogger().log,
      fetchImpl: fake.fetchImpl,
    }).catch(() => undefined);
    expect(fake.callsFor("TeamMeta")).toHaveLength(0);
  });

  test("a team without the setup names what is missing and points at the command", async () => {
    const promise = connect({
      TeamMeta: () => {
        const team = fullTeamData();
        team.team.states.nodes = team.team.states.nodes.filter(
          (s) => s.name !== "Needs Verification",
        );
        team.team.labels.nodes = team.team.labels.nodes.filter((l) => l.name !== "agent-2");
        return team;
      },
    });
    await expect(promise).rejects.toBeInstanceOf(LinearError);
    await expect(promise).rejects.toThrow(
      /state "Needs Verification".*label "marshall\/agent-2".*marshall linear setup/,
    );
  });
});

describe("listPickable", () => {
  test("filters by team, viewer, and unstarted state and maps the nodes", async () => {
    const { fake, client } = await connect({
      PickableIssues: () => ({
        issues: {
          nodes: [
            rawIssue({
              labels: { nodes: [agentLabelNode(1), { id: "l", name: "bug", parent: null }] },
            }),
          ],
        },
      }),
    });
    const issues = await client.listPickable();
    const call = fake.callsFor("PickableIssues")[0];
    expect(call?.variables).toEqual({ teamId: IDS.team, assigneeId: IDS.viewer });
    expect(call?.query).toContain('state: { type: { eq: "unstarted" } }');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.identifier).toBe("CB-1");
    expect(issues[0]?.labels).toEqual(["marshall/agent-1", "bug"]);
    expect(issues[0]?.branchName).toBe("cb-1-fix-the-thing");
  });
});

describe("claim", () => {
  test("moves to In Progress, adds our label, removes the others, and confirms on re-read", async () => {
    const { fake, client, lines } = await connect({
      IssueById: readsThen(
        rawDetail({ state: inProgress, labels: { nodes: [agentLabelNode(1)] } }),
      ),
    });
    expect(await client.claim("issue-1", "agent-1")).toBe(true);
    const update = fake.callsFor("UpdateIssue")[0];
    expect(update?.variables).toEqual({
      id: "issue-1",
      input: {
        stateId: IDS.inProgress,
        addedLabelIds: [IDS.agent1],
        removedLabelIds: [IDS.agent0, IDS.agent2],
      },
    });
    expect(fake.calls.map((c) => c.operationName).slice(2)).toEqual([
      "IssueById",
      "UpdateIssue",
      "IssueById",
    ]);
    expect(lines.find((l) => l.event === "linear.claimed")?.fields.agentId).toBe("agent-1");
  });

  test("rejects an unknown agent id before any request", async () => {
    const { fake, client } = await connect();
    await expect(client.claim("issue-1", "agent-9" as "agent-0")).rejects.toThrow(
      /Unknown agent id/,
    );
    expect(fake.callsFor("IssueById")).toHaveLength(0);
  });
});

describe("claim refusals", () => {
  test("returns false without writing when the issue is already started", async () => {
    const { fake, client } = await connect({
      IssueById: () => ({ issue: rawDetail({ state: inProgress }) }),
    });
    expect(await client.claim("issue-1", "agent-0")).toBe(false);
    expect(fake.callsFor("UpdateIssue")).toHaveLength(0);
  });

  test("returns false without writing when another agent holds the label", async () => {
    const { fake, client } = await connect({
      IssueById: () => ({ issue: rawDetail({ labels: { nodes: [agentLabelNode(2)] } }) }),
    });
    expect(await client.claim("issue-1", "agent-0")).toBe(false);
    expect(fake.callsFor("UpdateIssue")).toHaveLength(0);
  });

  test("returns false when the re-read shows a different holder", async () => {
    const { client, lines } = await connect({
      IssueById: readsThen(
        rawDetail({ state: inProgress, labels: { nodes: [agentLabelNode(2)] } }),
      ),
    });
    expect(await client.claim("issue-1", "agent-0")).toBe(false);
    expect(lines.find((l) => l.event === "linear.claim_lost")?.fields.holders).toEqual(["agent-2"]);
  });

  test("returns false when the re-read shows two holders", async () => {
    const { client } = await connect({
      IssueById: readsThen(
        rawDetail({ state: inProgress, labels: { nodes: [agentLabelNode(0), agentLabelNode(1)] } }),
      ),
    });
    expect(await client.claim("issue-1", "agent-0")).toBe(false);
  });
});

describe("release", () => {
  test("moves to Todo and removes every agent label", async () => {
    const { fake, client } = await connect();
    await client.release("issue-1");
    expect(fake.callsFor("UpdateIssue")[0]?.variables).toEqual({
      id: "issue-1",
      input: { stateId: IDS.todo, removedLabelIds: [IDS.agent0, IDS.agent1, IDS.agent2] },
    });
    expect(fake.callsFor("CreateComment")).toHaveLength(0);
  });

  test("posts the optional comment after the update", async () => {
    const { fake, client } = await connect();
    await client.release("issue-1", { comment: "Agent died; back to Todo." });
    const ops = fake.calls.map((c) => c.operationName).slice(2);
    expect(ops).toEqual(["UpdateIssue", "CreateComment"]);
    expect(fake.callsFor("CreateComment")[0]?.variables).toEqual({
      input: { issueId: "issue-1", body: `Agent died; back to Todo.${MARSHALL_COMMENT_FOOTER}` },
    });
  });
});

describe("setState and comment", () => {
  test("setState resolves the cached id and rejects unknown names", async () => {
    const { fake, client } = await connect();
    await client.setState("issue-1", "Needs Verification");
    expect(fake.callsFor("UpdateIssue")[0]?.variables).toEqual({
      id: "issue-1",
      input: { stateId: IDS.needsVerification },
    });
    await expect(client.setState("issue-1", "Nope")).rejects.toThrow(
      /Unknown workflow state "Nope"/,
    );
  });

  test("comment appends the Marshall footer", async () => {
    const { fake, client } = await connect();
    await client.comment("issue-1", "Plan posted.");
    expect(fake.callsFor("CreateComment")[0]?.variables).toEqual({
      input: { issueId: "issue-1", body: `Plan posted.${MARSHALL_COMMENT_FOOTER}` },
    });
  });
});

describe("createFollowUp", () => {
  test("creates the issue for me with agent-filed and no priority, then relates it", async () => {
    const { fake, client } = await connect();
    const created = await client.createFollowUp("issue-1", {
      title: "Split the helper",
      description: "Found while doing CB-1.",
    });
    expect(created).toEqual({
      id: "issue-new",
      identifier: "CB-99",
      url: "https://linear.app/chessbuddy/issue/CB-99",
    });
    const create = fake.callsFor("CreateIssue")[0]?.variables as { input: Record<string, unknown> };
    expect(create.input).toEqual({
      teamId: IDS.team,
      title: "Split the helper",
      description: "Found while doing CB-1.",
      assigneeId: IDS.viewer,
      labelIds: [IDS.agentFiled],
    });
    expect(create.input).not.toHaveProperty("priority");
    expect(create.input).not.toHaveProperty("stateId");
    expect(fake.callsFor("CreateRelation")[0]?.variables).toEqual({
      input: { issueId: "issue-new", relatedIssueId: "issue-1", type: "related" },
    });
  });
});

describe("getIssue and mappers", () => {
  const human = {
    id: "c1",
    body: "Please also fix the footer",
    createdAt: "2026-09-19T01:00:00.000Z",
  };
  const marshall = {
    id: "c2",
    body: `Plan posted.${MARSHALL_COMMENT_FOOTER}`,
    createdAt: "2026-09-19T02:00:00.000Z",
  };
  const olderHuman = { id: "c0", body: "First ask", createdAt: "2026-09-19T00:30:00.000Z" };

  test("getIssue maps state, agentId, latestHumanComment, and relations from both directions", async () => {
    const { client } = await connect({
      IssueById: () => ({
        issue: rawDetail({
          state: inProgress,
          labels: { nodes: [agentLabelNode(0)] },
          comments: { nodes: [marshall, olderHuman, human] },
          relations: { nodes: [{ type: "related", relatedIssue: { id: "issue-origin" } }] },
          inverseRelations: { nodes: [{ type: "related", issue: { id: "issue-child" } }] },
        }),
      }),
    });
    const detail = await client.getIssue("issue-1");
    expect(detail.state).toEqual({ name: "In Progress", type: "started" });
    expect(detail.agentId).toBe("agent-0");
    expect(detail.comments.map((c) => c.id)).toEqual(["c0", "c1", "c2"]);
    expect(detail.comments.map((c) => c.fromMarshall)).toEqual([false, false, true]);
    expect(detail.latestHumanComment?.id).toBe("c1");
    expect(detail.relatedIssueIds).toEqual(["issue-origin", "issue-child"]);
  });

  test("latestHumanComment is null when every comment is Marshall's", () => {
    const detail = toDetail(rawDetail({ comments: { nodes: [marshall] } }));
    expect(detail.latestHumanComment).toBeNull();
    expect(detail.agentId).toBeNull();
  });

  test("isFromMarshall tolerates trailing whitespace", () => {
    expect(isFromMarshall(`x${MARSHALL_COMMENT_FOOTER}\n`)).toBe(true);
    expect(isFromMarshall("x")).toBe(false);
  });

  test("agent labels outside the marshall group do not count", () => {
    const nodes = [
      { id: "a", name: "agent-0", parent: null },
      { id: "b", name: "agent-1", parent: { name: "other" } },
      { id: "c", name: "agent-2", parent: { name: "marshall" } },
    ];
    expect(agentLabelsOf(nodes)).toEqual(["agent-2"]);
    expect(agentLabelOf(nodes)).toBe("agent-2");
    expect(toPickable(rawIssue({ labels: { nodes } })).labels).toEqual([
      "agent-0",
      "other/agent-1",
      "marshall/agent-2",
    ]);
  });
});
