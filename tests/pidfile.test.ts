// Last edited: 2026-09-21 00:55 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { pidPath } from "../src/paths.ts";
import {
  liveOrchestrator,
  processAlive,
  readPidfile,
  removePidfile,
  writePidfile,
} from "../src/pidfile.ts";
import { type TempHome, useTempHome } from "./helpers.ts";

let home: TempHome;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  home.restore();
});

describe("pidfile", () => {
  test("write, read, live for this process, remove", () => {
    const now = new Date("2026-09-21T05:00:00.000Z");
    expect(readPidfile()).toBeNull();
    expect(liveOrchestrator()).toBeNull();
    writePidfile(now);
    expect(pidPath().startsWith(home.dir)).toBe(true);
    expect(readPidfile()).toEqual({ pid: process.pid, startedAt: now.toISOString() });
    expect(liveOrchestrator()?.pid).toBe(process.pid);
    removePidfile();
    expect(existsSync(pidPath())).toBe(false);
    removePidfile();
  });

  test("a stale pid or a garbage file reads as not running", () => {
    // A pid no process can have (pid_max on every platform is far below this).
    writePidfile(new Date(), 2 ** 30);
    expect(readPidfile()?.pid).toBe(2 ** 30);
    expect(liveOrchestrator()).toBeNull();
    expect(processAlive(2 ** 30)).toBe(false);
    writeFileSync(pidPath(), "not json");
    expect(readPidfile()).toBeNull();
    writeFileSync(pidPath(), JSON.stringify({ pid: -1 }));
    expect(readPidfile()).toBeNull();
  });
});
