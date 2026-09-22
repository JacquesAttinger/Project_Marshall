// Last edited: 2026-09-22 12:44 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { composeProjectName, IsolationError, implementEnv, slotEnv } from "../src/isolation.ts";
import { type TempHome, useTempHome } from "./helpers.ts";

let home: TempHome;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  home.restore();
});

/** ChessBuddy's three published ports, as marshall.config.json declares them. */
function config(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    workspace: "chessbuddy",
    teamId: "team-1",
    repoPath: home.dir,
    services: { POSTGRES_HOST_PORT: 5432, ELASTICMQ_HOST_PORT: 9324, API_HOST_PORT: 8000 },
    ...overrides,
  });
}

describe("slotEnv", () => {
  test("slot 0 keeps the default ports and names the project marshall-0", () => {
    expect(slotEnv(0, config())).toEqual({
      MARSHALL_SLOT: "0",
      COMPOSE_PROJECT_NAME: "marshall-0",
      POSTGRES_HOST_PORT: "5432",
      ELASTICMQ_HOST_PORT: "9324",
      API_HOST_PORT: "8000",
    });
    expect(composeProjectName(0)).toBe("marshall-0");
  });

  test("slot 1 adds one offset to every port", () => {
    expect(slotEnv(1, config())).toEqual({
      MARSHALL_SLOT: "1",
      COMPOSE_PROJECT_NAME: "marshall-1",
      POSTGRES_HOST_PORT: "5532",
      ELASTICMQ_HOST_PORT: "9424",
      API_HOST_PORT: "8100",
    });
  });

  test("the offset comes from config", () => {
    expect(slotEnv(1, config({ portOffsetPerSlot: 1000 })).API_HOST_PORT).toBe("9000");
  });

  test("no services configured → only the slot and the project name", () => {
    expect(slotEnv(1, config({ services: {} }))).toEqual({
      MARSHALL_SLOT: "1",
      COMPOSE_PROJECT_NAME: "marshall-1",
    });
  });

  test("out-of-range and non-integer slots throw", () => {
    for (const slot of [-1, 2, 1.5, Number.NaN]) {
      expect(() => slotEnv(slot, config())).toThrow(IsolationError);
    }
    expect(() => slotEnv(2, config({ maxAgents: 3 }))).not.toThrow();
  });

  test("a port pushed above 65535 throws", () => {
    expect(() => slotEnv(1, config({ services: { X_PORT: 65500 } }))).toThrow(/65535/);
  });
});

describe("implementEnv", () => {
  test("adds the issue dir and url on top of the slot env", () => {
    const env = implementEnv("CB-12", "https://linear.app/x/issue/CB-12", 1, config());
    expect(env.COMPOSE_PROJECT_NAME).toBe("marshall-1");
    expect(env.API_HOST_PORT).toBe("8100");
    expect(env.MARSHALL_ISSUE_DIR).toBe(join(home.dir, "issues", "CB-12"));
    expect(env.MARSHALL_ISSUE_URL).toBe("https://linear.app/x/issue/CB-12");
    expect(env.MARSHALL_MAX_CYCLES).toBe("4");
    expect(env.MARSHALL_BASE_BRANCH).toBe("main");
    expect(
      implementEnv("CB-12", "u", 0, config({ baseBranch: "master" })).MARSHALL_BASE_BRANCH,
    ).toBe("master");
    expect(implementEnv("CB-12", "u", 0, config({ maxFixCycles: 1 })).MARSHALL_MAX_CYCLES).toBe(
      "1",
    );
  });
});

describe("config.services", () => {
  test("keys must look like env vars and ports must be in range", () => {
    expect(() => config({ services: { "postgres-port": 5432 } })).toThrow(/services/);
    expect(() => config({ services: { POSTGRES_HOST_PORT: 70000 } })).toThrow(/services/);
    expect(() => config({ services: { POSTGRES_HOST_PORT: 0 } })).toThrow(/services/);
  });

  test("defaults: no services, offset 100", () => {
    const parsed = parseConfig({ workspace: "w", teamId: "t", repoPath: home.dir });
    expect(parsed.services).toEqual({});
    expect(parsed.portOffsetPerSlot).toBe(100);
  });
});
