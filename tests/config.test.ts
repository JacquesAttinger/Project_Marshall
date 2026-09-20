// Last edited: 2026-09-19 21:28 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, loadEnv, parseConfig, resolveConfigPath } from "../src/config.ts";
import { type TempHome, useTempHome } from "./helpers.ts";

let home: TempHome;
let previousConfigEnv: string | undefined;

beforeEach(() => {
  home = useTempHome();
  previousConfigEnv = process.env.MARSHALL_CONFIG;
  delete process.env.MARSHALL_CONFIG;
});

afterEach(() => {
  if (previousConfigEnv === undefined) delete process.env.MARSHALL_CONFIG;
  else process.env.MARSHALL_CONFIG = previousConfigEnv;
  home.restore();
});

/** A minimal valid config whose repoPath is the temp dir (always exists). */
function minimal() {
  return { workspace: "chessbuddy", repoPath: home.dir };
}

describe("parseConfig", () => {
  test("valid object passes and fills defaults", () => {
    const config = parseConfig(minimal());
    expect(config.workspace).toBe("chessbuddy");
    expect(config.teamId).toBe("");
    expect(config.baseBranch).toBe("main");
    expect(config.maxAgents).toBe(2);
    expect(config.dailyStartCap).toBe(6);
    expect(config.windowStartCap).toBe(2);
    expect(config.windowHours).toBe(5);
    expect(config.pollSeconds).toBe(45);
    expect(config.stallMinutes).toBe(5);
    expect(config.issueTimeoutHours).toBe(2);
    expect(config.maxFixCycles).toBe(4);
    expect(config.maxBounces).toBe(3);
    expect(config.maxResumes).toBe(2);
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("maxAgents above 3 fails and names the key", () => {
    expect(() => parseConfig({ ...minimal(), maxAgents: 5 })).toThrow(ConfigError);
    expect(() => parseConfig({ ...minimal(), maxAgents: 5 })).toThrow(/maxAgents/);
  });

  test("repoPath that is not a directory fails", () => {
    const missing = join(home.dir, "does-not-exist");
    expect(() => parseConfig({ ...minimal(), repoPath: missing })).toThrow(/repoPath/);
  });

  test("repoPath tilde expands to the home directory", () => {
    const config = parseConfig({ ...minimal(), repoPath: "~" });
    expect(config.repoPath).toBe(homedir());
  });

  test("unknown keys are rejected", () => {
    expect(() => parseConfig({ ...minimal(), bogus: 1 })).toThrow(/bogus/);
  });
});

describe("loadConfig", () => {
  test("MARSHALL_CONFIG override is honored", () => {
    const path = join(home.dir, "custom.json");
    writeFileSync(path, JSON.stringify({ ...minimal(), pollSeconds: 60 }));
    process.env.MARSHALL_CONFIG = path;
    expect(resolveConfigPath()).toBe(path);
    expect(loadConfig().pollSeconds).toBe(60);
  });

  test("explicit path wins over MARSHALL_CONFIG", () => {
    const envPath = join(home.dir, "env.json");
    const argPath = join(home.dir, "arg.json");
    writeFileSync(envPath, JSON.stringify({ ...minimal(), pollSeconds: 60 }));
    writeFileSync(argPath, JSON.stringify({ ...minimal(), pollSeconds: 90 }));
    process.env.MARSHALL_CONFIG = envPath;
    expect(loadConfig(argPath).pollSeconds).toBe(90);
  });

  test("missing file throws ConfigError with the path", () => {
    const path = join(home.dir, "nope.json");
    expect(() => loadConfig(path)).toThrow(ConfigError);
    expect(() => loadConfig(path)).toThrow(path);
  });

  test("invalid JSON throws ConfigError", () => {
    const path = join(home.dir, "bad.json");
    writeFileSync(path, "{ not json");
    expect(() => loadConfig(path)).toThrow(/not valid JSON/);
  });

  test("the committed marshall.config.json is valid", () => {
    const config = loadConfig();
    expect(config.workspace).toBe("chessbuddy");
  });
});

describe("loadEnv", () => {
  test("both keys are optional in step 01", () => {
    const env = loadEnv({});
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(env.NTFY_TOPIC_PREFIX).toBeUndefined();
  });

  test("present keys pass through", () => {
    const env = loadEnv({ LINEAR_API_KEY: "lin_x", NTFY_TOPIC_PREFIX: "marshall" });
    expect(env.LINEAR_API_KEY).toBe("lin_x");
    expect(env.NTFY_TOPIC_PREFIX).toBe("marshall");
  });
});
