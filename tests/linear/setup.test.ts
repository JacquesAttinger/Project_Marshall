// Last edited: 2026-09-21 15:10 CDT

import { describe, expect, test } from "bun:test";
import { createGql } from "../../src/linear/gql.ts";
import type { TeamMeta } from "../../src/linear/queries.ts";
import { ensureWorkspaceSetup, positionAfterInProgress } from "../../src/linear/setup.ts";
import { recordingLogger } from "../helpers.ts";
import { fakeLinear, fullTeamData, type Handler, IDS } from "./fake-linear.ts";

type Team = TeamMeta;

function emptyTeam(): Team {
  const team = fullTeamData().team;
  team.states.nodes = team.states.nodes.filter(
    (s) => s.name !== "Needs Verification" && s.name !== "Blocked",
  );
  team.labels.nodes = [];
  return team;
}

async function runSetup(team: Team, extra: Record<string, Handler> = {}) {
  const fake = fakeLinear({ TeamMeta: () => ({ team }), ...extra });
  const { log } = recordingLogger();
  const gql = createGql({ apiKey: "k", log, fetchImpl: fake.fetchImpl });
  const result = await ensureWorkspaceSetup(gql, IDS.team, log);
  return { fake, result };
}

const mutations = (fake: ReturnType<typeof fakeLinear>) =>
  fake.calls.filter((c) => c.operationName !== "TeamMeta").map((c) => c.operationName);

describe("ensureWorkspaceSetup from an empty team", () => {
  test("creates the states, the labels, the group, and three children in order", async () => {
    const { fake, result } = await runSetup(emptyTeam());
    expect(mutations(fake)).toEqual([
      "CreateState",
      "CreateState",
      "CreateLabel",
      "CreateLabel",
      "CreateLabel",
      "CreateLabel",
      "CreateLabel",
      "CreateLabel",
    ]);
    expect(fake.callsFor("TeamMeta")).toHaveLength(1);
    expect(result.needsVerification).toEqual({
      id: "state-new",
      name: "Needs Verification",
      created: true,
    });
    expect(result.blocked).toEqual({ id: "state-new", name: "Blocked", created: true });
    expect(result.agentFiled.created).toBe(true);
    expect(result.humanOnly.created).toBe(true);
    expect(result.marshallGroup).toEqual({
      id: "label-new-marshall",
      name: "marshall",
      created: true,
    });
    expect(result.agents.map((a) => a.created)).toEqual([true, true, true]);
  });

  test("sends the state inputs the plan specifies, Blocked right after Needs Verification", async () => {
    const { fake } = await runSetup(emptyTeam());
    const inputs = fake
      .callsFor("CreateState")
      .map((c) => (c.variables as { input: Record<string, unknown> }).input);
    expect(inputs[0]).toEqual({
      teamId: IDS.team,
      name: "Needs Verification",
      type: "started",
      color: "#f2c94c",
      position: 2.5,
    });
    expect(inputs[1]).toEqual({
      teamId: IDS.team,
      name: "Blocked",
      type: "started",
      color: "#eb5757",
      position: 2.75,
    });
  });

  test("creates the group first and parents the children to its new id", async () => {
    const { fake } = await runSetup(emptyTeam());
    const labelInputs = fake
      .callsFor("CreateLabel")
      .map((c) => (c.variables as { input: unknown }).input);
    expect(labelInputs[0]).toEqual({ teamId: IDS.team, name: "agent-filed" });
    expect(labelInputs[1]).toEqual({ teamId: IDS.team, name: "human-only" });
    expect(labelInputs[2]).toEqual({ teamId: IDS.team, name: "marshall", isGroup: true });
    for (const [i, slot] of ["agent-0", "agent-1", "agent-2"].entries()) {
      expect(labelInputs[3 + i]).toEqual({
        teamId: IDS.team,
        name: slot,
        parentId: "label-new-marshall",
      });
    }
  });
});

describe("ensureWorkspaceSetup on an existing team", () => {
  test("creates nothing when everything exists", async () => {
    const { fake, result } = await runSetup(fullTeamData().team);
    expect(mutations(fake)).toEqual([]);
    expect(result.needsVerification).toEqual({
      id: IDS.needsVerification,
      name: "Needs Verification",
      created: false,
    });
    expect(result.blocked).toEqual({ id: IDS.blocked, name: "Blocked", created: false });
    expect(result.agentFiled.id).toBe(IDS.agentFiled);
    expect(result.humanOnly.id).toBe(IDS.humanOnly);
    expect(result.marshallGroup.id).toBe(IDS.marshall);
    expect(result.agents.map((a) => a.id)).toEqual([IDS.agent0, IDS.agent1, IDS.agent2]);
    expect(result.agents.every((a) => !a.created)).toBe(true);
  });

  test("creates only what is missing when partially set up", async () => {
    const team = fullTeamData().team;
    team.labels.nodes = team.labels.nodes.filter(
      (l) => l.name !== "agent-1" && l.name !== "agent-filed",
    );
    const { fake, result } = await runSetup(team);
    expect(mutations(fake)).toEqual(["CreateLabel", "CreateLabel"]);
    const inputs = fake
      .callsFor("CreateLabel")
      .map((c) => (c.variables as { input: { name: string; parentId?: string } }).input);
    expect(inputs.map((i) => i.name)).toEqual(["agent-filed", "agent-1"]);
    expect(inputs[1]?.parentId).toBe(IDS.marshall);
    expect(result.agents.map((a) => a.created)).toEqual([false, true, false]);
  });

  test("a stray top-level label with an agent name does not satisfy the group child", async () => {
    const team = fullTeamData().team;
    team.labels.nodes = team.labels.nodes.map((l) =>
      l.name === "agent-0" ? { ...l, parent: null } : l,
    );
    const { fake } = await runSetup(team);
    expect(mutations(fake)).toEqual(["CreateLabel"]);
  });
});

describe("positionAfterInProgress", () => {
  const state = (name: string, position: number) => ({ id: name, name, type: "x", position });

  test("midway to the next state", () => {
    expect(
      positionAfterInProgress([state("Todo", 1), state("In Progress", 2), state("Done", 4)]),
    ).toBe(3);
  });

  test("plus one when In Progress is last", () => {
    expect(positionAfterInProgress([state("Todo", 1), state("In Progress", 7)])).toBe(8);
  });

  test("after everything when In Progress is missing", () => {
    expect(positionAfterInProgress([state("Todo", 1), state("Done", 3)])).toBe(4);
    expect(positionAfterInProgress([])).toBe(1);
  });
});
