// Last edited: 2026-09-19 22:55 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_SETTINGS_PATH,
  buildAgentSettings,
  eventsFile,
  HOOK_EVENTS,
  HOOK_SINK_PATH,
  hookCommand,
  loadBaseSettings,
  shellQuote,
} from "../../src/runner/settings.ts";
import { type TempHome, useTempHome } from "../helpers.ts";

let home: TempHome;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  home.restore();
});

type HookGroup = { hooks: { type: string; command: string; timeout: number }[] };

function parse(json: string): Record<string, unknown> & { hooks: Record<string, HookGroup[]> } {
  return JSON.parse(json);
}

describe("buildAgentSettings", () => {
  test("committed files exist and the sink is executable", () => {
    expect(existsSync(AGENT_SETTINGS_PATH)).toBe(true);
    expect(existsSync(HOOK_SINK_PATH)).toBe(true);
    expect(Bun.file(HOOK_SINK_PATH).size).toBeGreaterThan(0);
  });

  test("output parses and carries the six hook events", () => {
    const settings = parse(buildAgentSettings("run-1"));
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
  });

  test("every hook command names the sink and this run's events file", () => {
    const settings = parse(buildAgentSettings("plan-deadbeef"));
    const expected = eventsFile("plan-deadbeef");
    expect(expected).toBe(join(home.dir, "events", "plan-deadbeef.jsonl"));
    for (const name of HOOK_EVENTS) {
      const groups = settings.hooks[name] as HookGroup[];
      expect(groups).toHaveLength(1);
      const hook = groups[0]?.hooks[0];
      expect(hook?.type).toBe("command");
      expect(hook?.command).toBe(hookCommand("plan-deadbeef"));
      expect(hook?.command).toContain(HOOK_SINK_PATH);
      expect(hook?.command).toContain(expected);
      expect(hook?.timeout).toBe(name === "SessionEnd" ? 3 : 5);
    }
  });

  test("base keys survive the merge", () => {
    const base = loadBaseSettings();
    const settings = parse(buildAgentSettings("run-1"));
    for (const key of Object.keys(base)) {
      expect(settings[key]).toEqual(base[key]);
    }
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect((settings.env as Record<string, string>).ANTHROPIC_DEFAULT_FABLE_MODEL).toContain(
      "fable",
    );
  });

  test("hooks already in the base file are kept, ours are appended", () => {
    const base = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi", timeout: 1 }] }] },
    };
    const settings = parse(buildAgentSettings("run-1", base));
    const stop = settings.hooks.Stop as HookGroup[];
    expect(stop).toHaveLength(2);
    expect(stop[0]?.hooks[0]?.command).toBe("echo hi");
    expect(stop[1]?.hooks[0]?.command).toBe(hookCommand("run-1"));
  });

  test("shellQuote handles single quotes and spaces", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("hook-sink.sh", () => {
  test("wraps stdin in {received_at, event} and appends one line", async () => {
    const out = eventsFile("sink-test");
    const payload = { hook_event_name: "Stop", session_id: "s1" };
    for (let i = 0; i < 2; i++) {
      const proc = Bun.spawn(["sh", HOOK_SINK_PATH, out], { stdin: "pipe", stdout: "ignore" });
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
    }
    const lines = (await Bun.file(out).text()).trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string);
    expect(first.event).toEqual(payload);
    expect(Number.isNaN(Date.parse(first.received_at))).toBe(false);
  });

  test("a pretty-printed payload with a trailing newline still lands on one line", async () => {
    const out = eventsFile("sink-multiline");
    const payload = { hook_event_name: "Stop", last_assistant_message: "line1\nline2" };
    const proc = Bun.spawn(["sh", HOOK_SINK_PATH, out], { stdin: "pipe", stdout: "ignore" });
    proc.stdin.write(`${JSON.stringify(payload, null, 2)}\n`);
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
    const text = await Bun.file(out).text();
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(text).event).toEqual(payload);
  });
});
