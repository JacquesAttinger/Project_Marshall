// Last edited: 2026-09-20 15:15 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { dispatch, parseArgs } from "../src/cli/index.ts";
import { collectStatus } from "../src/cli/status.ts";
import { type TempHome, useTempConfig, useTempHome } from "./helpers.ts";

let home: TempHome;

beforeEach(() => {
  home = useTempHome();
  useTempConfig(home);
});

afterEach(() => {
  home.restore();
});

describe("parseArgs", () => {
  test("splits positionals and flags", () => {
    const p = parseArgs(["db", "migrate", "--json", "--config", "/x.json"]);
    expect(p.positional).toEqual(["db", "migrate"]);
    expect(p.json).toBe(true);
    expect(p.configPath).toBe("/x.json");
  });

  test("accepts --config=path", () => {
    expect(parseArgs(["status", "--config=/y.json"]).configPath).toBe("/y.json");
  });

  test("rejects unknown options and a dangling --config", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--config"])).toThrow(/needs a path/);
    expect(() => parseArgs(["--cwd"])).toThrow(/--cwd needs a path/);
  });

  test("plan flags: --cwd (both spellings) and --revise", () => {
    const p = parseArgs(["plan", "CB-12", "--cwd", "/wt", "--revise"]);
    expect(p).toMatchObject({ positional: ["plan", "CB-12"], cwd: "/wt", revise: true });
    expect(parseArgs(["plan", "CB-12", "--cwd=/wt2"]).cwd).toBe("/wt2");
    expect(parseArgs(["status"]).revise).toBe(false);
  });
});

describe("plan commands", () => {
  const plans = resolve(import.meta.dir, "fixtures", "plans");

  test("plan check exits 0 on a good file and 1 on a bad one", async () => {
    expect(await dispatch(["plan", "check", join(plans, "good_plan.md")])).toBe(0);
    expect(await dispatch(["plan", "check", join(plans, "missing_plan.md"), "--json"])).toBe(1);
    expect(await dispatch(["plan", "check"])).toBe(2);
    await expect(dispatch(["plan", "check", "/nope.md"])).rejects.toThrow(/No such file/);
  });

  test("plan needs an identifier and an existing --cwd before it touches anything", async () => {
    expect(await dispatch(["plan"])).toBe(2);
    expect(await dispatch(["plan", "CB-1", "extra"])).toBe(2);
    await expect(dispatch(["plan", "CB-1"])).rejects.toThrow(/needs --cwd/);
    await expect(dispatch(["plan", "CB-1", "--cwd", join(home.dir, "missing")])).rejects.toThrow(
      /does not exist/,
    );
    expect(existsSync(join(home.dir, "marshall.db"))).toBe(false);
  });
});

describe("dispatch", () => {
  test("unknown command exits 2, help exits 0, no command exits 2", async () => {
    expect(await dispatch(["frob"])).toBe(2);
    expect(await dispatch(["db"])).toBe(2);
    expect(await dispatch(["status", "extra"])).toBe(2);
    expect(await dispatch(["--help"])).toBe(0);
    expect(await dispatch([])).toBe(2);
  });

  test("db migrate creates the DB and status reports version 3", async () => {
    const before = collectStatus();
    expect(before.dbExists).toBe(false);
    expect(before.schemaVersion).toBe(0);

    expect(await dispatch(["db", "migrate"])).toBe(0);
    expect(existsSync(join(home.dir, "marshall.db"))).toBe(true);

    const after = collectStatus();
    expect(after.dbExists).toBe(true);
    expect(after.schemaVersion).toBe(3);
    expect(after.counts).toEqual({ claims: 0, starts: 0, events: 0, runs: 0 });
    expect(after.marshallHome).toBe(home.dir);
  });

  test("status does not create the DB", async () => {
    expect(await dispatch(["status", "--json"])).toBe(0);
    expect(existsSync(join(home.dir, "marshall.db"))).toBe(false);
  });

  test("linear setup without a key fails with the ConfigError message", async () => {
    const previous = process.env.MARSHALL_LINEAR_API_KEY;
    delete process.env.MARSHALL_LINEAR_API_KEY;
    try {
      await expect(dispatch(["linear", "setup"])).rejects.toThrow(/MARSHALL_LINEAR_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.MARSHALL_LINEAR_API_KEY = previous;
    }
  });
});
