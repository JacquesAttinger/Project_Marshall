// Last edited: 2026-09-19 23:20 CDT
// Real-workspace test. Runs only with MARSHALL_LINEAR_E2E=1 and MARSHALL_LINEAR_API_KEY set.
// Creates throwaway issues in the configured team and deletes them (30-day trash) in afterAll.
// The describe blocks run in file order and share one client; each test builds on the last.
//
//   MARSHALL_LINEAR_E2E=1 bun test tests/linear.e2e.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig, loadEnv, requireLinearApiKey } from "../src/config.ts";
import { connectLinear, type LinearClient, run } from "../src/linear/client.ts";
import { createGql, type Gql } from "../src/linear/gql.ts";
import { CreateIssue, DeleteIssue } from "../src/linear/queries.ts";
import { ensureWorkspaceSetup } from "../src/linear/setup.ts";
import { createLogger } from "../src/log.ts";

const enabled = process.env.MARSHALL_LINEAR_E2E === "1";
const log = createLogger({ test: "linear.e2e" });
const stamp = new Date().toISOString();

let workspace = "";
let teamId = "";
let gql: Gql;
let client: LinearClient;
let issueId = "";
let followUpId = "";
const created: string[] = [];

const pickableIds = async () => (await client.listPickable()).map((i) => i.id);

beforeAll(async () => {
  if (!enabled) return;
  const config = loadConfig();
  const apiKey = requireLinearApiKey(loadEnv());
  workspace = config.workspace;
  teamId = config.teamId;
  gql = createGql({ apiKey, log });
  client = await connectLinear({ apiKey, teamId, workspace, log });
});

afterAll(async () => {
  if (!enabled || !client) return;
  for (const id of created) {
    await run(gql, DeleteIssue, { id }).catch((err) =>
      log.error("e2e.cleanup_failed", { id, err: String(err) }),
    );
  }
  const left = await pickableIds();
  for (const id of created) expect(left).not.toContain(id);
});

describe.skipIf(!enabled)("Linear e2e: connect and setup", () => {
  test("1. connectLinear passes the workspace guard", () => {
    expect(client.whoami().workspace).toBe(workspace);
    expect(client.budget()).not.toBeNull();
  });

  test("2. ensureWorkspaceSetup is idempotent", async () => {
    await ensureWorkspaceSetup(gql, teamId, log);
    const second = await ensureWorkspaceSetup(gql, teamId, log);
    expect(second.needsVerification.created).toBe(false);
    expect(second.agentFiled.created).toBe(false);
    expect(second.marshallGroup.created).toBe(false);
    expect(second.agents.every((a) => !a.created)).toBe(true);
  });
});

describe.skipIf(!enabled)("Linear e2e: claim flow", () => {
  test("3. a fresh Todo issue assigned to me is pickable", async () => {
    const { issueCreate } = await run(gql, CreateIssue, {
      input: {
        teamId,
        title: `[marshall e2e] ${stamp}`,
        description: "Throwaway issue created by tests/linear.e2e.test.ts. Safe to delete.",
        assigneeId: client.whoami().userId,
      },
    });
    issueId = issueCreate.issue.id;
    created.push(issueId);
    expect(await pickableIds()).toContain(issueId);
  });

  test("4. claim as agent-0 succeeds and removes it from the pickable list", async () => {
    expect(await client.claim(issueId, "agent-0")).toBe(true);
    expect(await pickableIds()).not.toContain(issueId);
    const detail = await client.getIssue(issueId);
    expect(detail.state.name).toBe("In Progress");
    expect(detail.agentId).toBe("agent-0");
  });

  test("5. a second claim as agent-1 fails and leaves agent-0's label", async () => {
    expect(await client.claim(issueId, "agent-1")).toBe(false);
    expect((await client.getIssue(issueId)).agentId).toBe("agent-0");
  });

  test("6. comment carries the footer and is not a human comment", async () => {
    await client.comment(issueId, "Plan posted by the e2e test.");
    const detail = await client.getIssue(issueId);
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0]?.fromMarshall).toBe(true);
    expect(detail.latestHumanComment).toBeNull();
  });

  test("7. Needs Verification is a started state and not pickable", async () => {
    await client.setState(issueId, "Needs Verification");
    const detail = await client.getIssue(issueId);
    expect(detail.state).toEqual({ name: "Needs Verification", type: "started" });
    expect(await pickableIds()).not.toContain(issueId);
  });
});

describe.skipIf(!enabled)("Linear e2e: follow-up and release", () => {
  test("8. createFollowUp files a related, agent-filed issue assigned to me", async () => {
    const followUp = await client.createFollowUp(issueId, {
      title: `[marshall e2e follow-up] ${stamp}`,
      description: "Throwaway follow-up created by tests/linear.e2e.test.ts.",
    });
    followUpId = followUp.id;
    created.push(followUpId);
    const detail = await client.getIssue(followUpId);
    expect(detail.labels).toContain("agent-filed");
    expect(detail.relatedIssueIds).toContain(issueId);
    expect(await pickableIds()).toContain(followUpId);
  });

  test("9. release puts it back in Todo with no agent label", async () => {
    await client.release(issueId);
    const detail = await client.getIssue(issueId);
    expect(detail.state.name).toBe("Todo");
    expect(detail.agentId).toBeNull();
    expect(await pickableIds()).toContain(issueId);
  });
});
