// Last edited: 2026-09-19 23:05 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { collectLinearSetup, formatLinearSetup } from "../../src/cli/linear.ts";
import { ConfigError } from "../../src/config.ts";
import { type TempHome, useTempConfig, useTempHome } from "../helpers.ts";
import { fakeLinear, fullTeamData, IDS } from "./fake-linear.ts";

let home: TempHome;
let previousKey: string | undefined;

beforeEach(() => {
  home = useTempHome();
  useTempConfig(home, { workspace: "chessbuddy", teamId: IDS.team });
  previousKey = process.env.MARSHALL_LINEAR_API_KEY;
  process.env.MARSHALL_LINEAR_API_KEY = "lin_test";
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.MARSHALL_LINEAR_API_KEY;
  else process.env.MARSHALL_LINEAR_API_KEY = previousKey;
  home.restore();
});

describe("marshall linear setup", () => {
  test("verifies the workspace, runs setup, and reports ids and budget", async () => {
    const fake = fakeLinear();
    const report = await collectLinearSetup({ json: false, fetchImpl: fake.fetchImpl });
    expect(fake.calls.map((c) => c.operationName)).toEqual(["Viewer", "TeamMeta"]);
    expect(report.workspace).toBe("chessbuddy");
    expect(report.user).toBe("Test User");
    expect(report.teamId).toBe(IDS.team);
    expect(report.budget?.remaining).toBe(2498);

    const text = formatLinearSetup(report);
    expect(text).toContain("Workspace chessbuddy as Test User");
    expect(text).toContain(`Needs Verification  ${IDS.needsVerification}`);
    expect(text).toContain(`marshall/agent-2    ${IDS.agent2}`);
    expect(text).toContain("Created: nothing (already set up)");
    expect(text).toContain("Rate budget: 2498/2500");
  });

  test("lists what it created", async () => {
    const fake = fakeLinear({
      TeamMeta: () => {
        const team = fullTeamData();
        team.team.labels.nodes = team.team.labels.nodes.filter((l) => l.name !== "agent-filed");
        return team;
      },
    });
    const report = await collectLinearSetup({ json: false, fetchImpl: fake.fetchImpl });
    expect(formatLinearSetup(report)).toContain("Created: agent-filed");
  });

  test("exits through ConfigError on a workspace mismatch and writes nothing", async () => {
    const fake = fakeLinear({
      Viewer: () => ({ viewer: { id: "u", name: "x", organization: { urlKey: "hemut" } } }),
    });
    const promise = collectLinearSetup({ json: false, fetchImpl: fake.fetchImpl });
    await expect(promise).rejects.toBeInstanceOf(ConfigError);
    expect(fake.calls.map((c) => c.operationName)).toEqual(["Viewer"]);
  });

  test("fails before any request when the key is missing", async () => {
    delete process.env.MARSHALL_LINEAR_API_KEY;
    const fake = fakeLinear();
    await expect(collectLinearSetup({ json: false, fetchImpl: fake.fetchImpl })).rejects.toThrow(
      /MARSHALL_LINEAR_API_KEY is not set/,
    );
    expect(fake.calls).toHaveLength(0);
  });
});
