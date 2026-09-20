// Last edited: 2026-09-20 12:40 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { blocksPath, decide, guard, MAX_STOP_BLOCKS } from "../scripts/stop-guard.ts";
import { HOOK_SINK_PATH } from "../src/runner/settings.ts";
import { type TempHome, useTempHome } from "./helpers.ts";

const GUARD = resolve(import.meta.dir, "..", "scripts", "stop-guard.ts");

let home: TempHome;
let statusFile: string;

beforeEach(() => {
  home = useTempHome("marshall-guard-");
  statusFile = join(home.dir, "issues", "CB-1", "implement.json");
});

afterEach(() => {
  home.restore();
});

const stopIdle = { hook_event_name: "Stop", background_tasks: [] };
const stopBusy = { hook_event_name: "Stop", background_tasks: [{ id: "a", status: "running" }] };

function writeStatus(outcome: string | null, phase = "reviewing"): void {
  mkdirSync(join(home.dir, "issues", "CB-1"), { recursive: true });
  writeFileSync(statusFile, JSON.stringify({ phase, outcome }));
}

describe("decide", () => {
  test("blocks an idle Stop while the outcome is null, naming the phase", () => {
    const verdict = decide(stopIdle, { outcome: null, phase: "reviewing" }, statusFile, 0);
    expect(verdict?.decision).toBe("block");
    expect(verdict?.reason).toContain("phase: reviewing");
  });

  test("blocks when the status file was never written", () => {
    expect(decide(stopIdle, null, statusFile, 0)?.reason).toContain("not been written");
  });

  test("allows once an outcome is set", () => {
    expect(decide(stopIdle, { outcome: "pr_green", phase: "done" }, statusFile, 0)).toBeNull();
  });

  test("allows a Stop with background tasks still running", () => {
    expect(decide(stopBusy, { outcome: null, phase: "reviewing" }, statusFile, 0)).toBeNull();
  });

  test("allows other events and stops blocking at the cap", () => {
    expect(decide({ hook_event_name: "SessionEnd" }, null, statusFile, 0)).toBeNull();
    expect(decide(stopIdle, null, statusFile, MAX_STOP_BLOCKS - 1)).not.toBeNull();
    expect(decide(stopIdle, null, statusFile, MAX_STOP_BLOCKS)).toBeNull();
  });
});

describe("guard", () => {
  test("counts blocks in the sidecar and stops at the cap", () => {
    writeStatus(null);
    for (let i = 0; i < MAX_STOP_BLOCKS; i++) {
      expect(guard(statusFile, JSON.stringify(stopIdle))?.decision).toBe("block");
    }
    expect(readFileSync(blocksPath(statusFile), "utf8")).toBe(String(MAX_STOP_BLOCKS));
    expect(guard(statusFile, JSON.stringify(stopIdle))).toBeNull();
  });

  test("bad stdin never throws", () => {
    expect(guard(statusFile, "not json")).toBeNull();
    expect(existsSync(blocksPath(statusFile))).toBe(false);
  });
});

describe("hook-sink.sh with a status file", () => {
  async function runSink(payload: object, out: string): Promise<string> {
    const proc = Bun.spawn(["sh", HOOK_SINK_PATH, out, statusFile], {
      stdin: "pipe",
      stdout: "pipe",
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
    return await new Response(proc.stdout).text();
  }

  test("prints the block decision and marks the line stop_blocked", async () => {
    writeStatus(null, "fixing");
    const out = join(home.dir, "events", "r.jsonl");
    const stdout = await runSink(stopIdle, out);
    expect(JSON.parse(stdout).decision).toBe("block");
    const lines = readFileSync(out, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.stop_blocked).toBe(true);
    expect(parsed.event).toEqual(stopIdle);
  });

  test("stays quiet once the outcome is written; the line has no stop_blocked", async () => {
    writeStatus("pr_green", "done");
    const out = join(home.dir, "events", "r.jsonl");
    expect(await runSink(stopIdle, out)).toBe("");
    expect(JSON.parse(readFileSync(out, "utf8")).stop_blocked).toBeUndefined();
  });

  test("the guard script runs standalone", async () => {
    writeStatus(null);
    const proc = Bun.spawn(["bun", GUARD, statusFile], { stdin: "pipe", stdout: "pipe" });
    proc.stdin.write(JSON.stringify(stopIdle));
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(await new Response(proc.stdout).text()).decision).toBe("block");
  });
});
