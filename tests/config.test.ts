// Last edited: 2026-09-20 10:56 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  loadEnv,
  parseConfig,
  requireLinearApiKey,
  resolveConfigPath,
} from "../src/config.ts";
import { type TempHome, useTempHome } from "./helpers.ts";

let home: TempHome;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  home.restore();
});

/** A minimal valid config whose repoPath is the temp dir (always exists). */
function minimal() {
  return { workspace: "chessbuddy", teamId: "team-1", repoPath: home.dir };
}

describe("parseConfig", () => {
  test("valid object passes and fills defaults", () => {
    const config = parseConfig(minimal());
    expect(config.workspace).toBe("chessbuddy");
    expect(config.teamId).toBe("team-1");
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
    expect(config.planMinutes).toBe(20);
    expect(config.models).toEqual({
      classifier: "haiku",
      planSimple: "opus",
      planComplex: "fable",
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("models block fills missing keys and rejects unknown or empty ones", () => {
    const partial = parseConfig({ ...minimal(), models: { planComplex: "opus" } });
    expect(partial.models).toEqual({
      classifier: "haiku",
      planSimple: "opus",
      planComplex: "opus",
    });
    expect(() => parseConfig({ ...minimal(), models: { planner: "opus" } })).toThrow(
      /models: Unrecognized key: "planner"/,
    );
    expect(() => parseConfig({ ...minimal(), models: { classifier: "" } })).toThrow(
      /models\.classifier/,
    );
  });

  test("maxAgents above 3 fails and names the key", () => {
    expect(() => parseConfig({ ...minimal(), maxAgents: 5 })).toThrow(ConfigError);
    expect(() => parseConfig({ ...minimal(), maxAgents: 5 })).toThrow(/maxAgents/);
  });

  test("teamId must be set", () => {
    expect(() => parseConfig({ ...minimal(), teamId: "" })).toThrow(/teamId/);
    const { teamId: _omitted, ...withoutTeam } = minimal();
    expect(() => parseConfig(withoutTeam)).toThrow(/teamId/);
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

  test("the committed marshall.config.json is valid apart from the machine-specific repoPath", () => {
    // CI has no ~/code/ChessBuddy, so swap repoPath for a directory that exists everywhere.
    const raw = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8"));
    expect(raw.repoPath).toBe("~/code/ChessBuddy");
    const config = parseConfig({ ...raw, repoPath: home.dir }, DEFAULT_CONFIG_PATH);
    expect(config.workspace).toBe("chessbuddy");
    expect(config.teamId).toBe("91f682c4-ff2b-4fa3-a3d6-46c22ea3882d");
    expect(config.maxAgents).toBe(2);
  });
});

describe("loadEnv", () => {
  test("both keys are optional at load time", () => {
    const env = loadEnv({});
    expect(env.MARSHALL_LINEAR_API_KEY).toBeUndefined();
    expect(env.NTFY_TOPIC_PREFIX).toBeUndefined();
  });

  test("present keys pass through", () => {
    const env = loadEnv({ MARSHALL_LINEAR_API_KEY: "lin_x", NTFY_TOPIC_PREFIX: "marshall" });
    expect(env.MARSHALL_LINEAR_API_KEY).toBe("lin_x");
    expect(env.NTFY_TOPIC_PREFIX).toBe("marshall");
  });

  test("the Hemut LINEAR_API_KEY is ignored", () => {
    const env = loadEnv({ LINEAR_API_KEY: "lin_hemut" });
    expect(env.MARSHALL_LINEAR_API_KEY).toBeUndefined();
    expect(() => requireLinearApiKey(env)).toThrow(ConfigError);
  });
});

describe("requireLinearApiKey", () => {
  test("returns the key when set", () => {
    expect(requireLinearApiKey(loadEnv({ MARSHALL_LINEAR_API_KEY: "lin_x" }))).toBe("lin_x");
  });

  test("names the variable and .env.example when missing", () => {
    expect(() => requireLinearApiKey(loadEnv({}))).toThrow(/MARSHALL_LINEAR_API_KEY/);
    expect(() => requireLinearApiKey(loadEnv({}))).toThrow(/\.env\.example/);
  });
});
