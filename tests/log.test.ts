// Last edited: 2026-09-21 00:05 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, rotateLog } from "../src/log.ts";
import { logPath } from "../src/paths.ts";
import { type TempHome, useTempHome } from "./helpers.ts";

let home: TempHome;
let previousQuiet: string | undefined;

beforeEach(() => {
  home = useTempHome();
  previousQuiet = process.env.MARSHALL_QUIET;
  process.env.MARSHALL_QUIET = "1";
});

afterEach(() => {
  if (previousQuiet === undefined) delete process.env.MARSHALL_QUIET;
  else process.env.MARSHALL_QUIET = previousQuiet;
  home.restore();
});

function lines(): Record<string, unknown>[] {
  return readFileSync(logPath(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("createLogger", () => {
  test("one call writes one parseable JSON line with ts, level, event", () => {
    createLogger().info("hello", { n: 1 });
    const [entry] = lines();
    expect(lines()).toHaveLength(1);
    expect(entry?.level).toBe("info");
    expect(entry?.event).toBe("hello");
    expect(entry?.n).toBe(1);
    expect(typeof entry?.ts).toBe("string");
    expect(Number.isNaN(Date.parse(entry?.ts as string))).toBe(false);
  });

  test("log file lives under MARSHALL_HOME", () => {
    createLogger().debug("x");
    expect(logPath().startsWith(home.dir)).toBe(true);
  });

  test("child fields merge and later fields win", () => {
    const log = createLogger({ agentId: "a1", scope: "base" });
    const child = log.child({ issueId: "CB-7", scope: "child" });
    child.warn("bounced", { scope: "call" });
    const [entry] = lines();
    expect(entry?.agentId).toBe("a1");
    expect(entry?.issueId).toBe("CB-7");
    expect(entry?.scope).toBe("call");
  });

  test("each level appends a new line", () => {
    const log = createLogger();
    log.debug("a");
    log.info("b");
    log.warn("c");
    log.error("d");
    expect(lines().map((l) => l.level)).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("rotateLog", () => {
  test("a small or missing file is left alone", () => {
    const path = join(home.dir, "small.log");
    expect(rotateLog(path, 100, 3)).toBe(false);
    writeFileSync(path, "x".repeat(100));
    expect(rotateLog(path, 100, 3)).toBe(false);
    expect(readFileSync(path, "utf8")).toHaveLength(100);
  });

  test("an oversized file shifts down the chain and the oldest beyond keep is dropped", () => {
    const path = join(home.dir, "big.log");
    for (const gen of ["one", "two", "three", "four"]) {
      writeFileSync(path, gen.repeat(50));
      expect(rotateLog(path, 100, 3)).toBe(true);
      expect(existsSync(path)).toBe(false);
    }
    expect(readFileSync(`${path}.1`, "utf8").startsWith("four")).toBe(true);
    expect(readFileSync(`${path}.2`, "utf8").startsWith("three")).toBe(true);
    expect(readFileSync(`${path}.3`, "utf8").startsWith("two")).toBe(true);
    expect(existsSync(`${path}.4`)).toBe(false);
  });
});
