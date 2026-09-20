// Last edited: 2026-09-19 21:36 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  });
});

describe("dispatch", () => {
  test("unknown command exits 2, help exits 0, no command exits 2", () => {
    expect(dispatch(["frob"])).toBe(2);
    expect(dispatch(["--help"])).toBe(0);
    expect(dispatch([])).toBe(2);
  });

  test("db migrate creates the DB and status reports version 1", () => {
    const before = collectStatus();
    expect(before.dbExists).toBe(false);
    expect(before.schemaVersion).toBe(0);

    expect(dispatch(["db", "migrate"])).toBe(0);
    expect(existsSync(join(home.dir, "marshall.db"))).toBe(true);

    const after = collectStatus();
    expect(after.dbExists).toBe(true);
    expect(after.schemaVersion).toBe(1);
    expect(after.counts).toEqual({ claims: 0, starts: 0, events: 0 });
    expect(after.marshallHome).toBe(home.dir);
  });

  test("status does not create the DB", () => {
    expect(dispatch(["status", "--json"])).toBe(0);
    expect(existsSync(join(home.dir, "marshall.db"))).toBe(false);
  });
});
