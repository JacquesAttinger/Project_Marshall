// Last edited: 2026-09-20 12:40 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { eventsDir } from "../../src/paths.ts";
import { buildArgv, kill, launch, mintRunId, parseJobId, resume } from "../../src/runner/launch.ts";
import { buildAgentSettings } from "../../src/runner/settings.ts";
import { getRun } from "../../src/runner/store.ts";
import { RunnerError } from "../../src/runner/types.ts";
import { fakeCalls, fakeStops, type RunnerEnv, setFakeNextId, useRunnerEnv } from "./helpers.ts";

let env: RunnerEnv;

beforeEach(() => {
  env = useRunnerEnv();
});

afterEach(() => {
  env.restore();
});

const BASE = { name: "CB-12", cwd: "/tmp", prompt: "Print hello, then stop.", model: "opus" };

describe("mintRunId / parseJobId", () => {
  test("run id is a slug plus 8 hex", () => {
    expect(mintRunId("CB-12 plan")).toMatch(/^cb-12-plan-[0-9a-f]{8}$/);
    expect(mintRunId("!!!")).toMatch(/^run-[0-9a-f]{8}$/);
    expect(mintRunId("a")).not.toBe(mintRunId("a"));
  });

  test("job id is the first 8-hex token", () => {
    expect(parseJobId("Started background session c140930f\nUse claude attach")).toBe("c140930f");
    expect(parseJobId("nothing here")).toBeNull();
  });
});

describe("buildArgv", () => {
  test("is exactly as documented, in order", () => {
    const argv = buildArgv("cb-12-00000000", {
      ...BASE,
      effort: "high",
      systemPromptAppend: "Be brief.",
      maxBudgetUsd: 5,
      extraArgs: ["--plugin-dir", "/p"],
    });
    expect(argv).toEqual([
      "--bg",
      "--name",
      "CB-12",
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
      "--settings",
      buildAgentSettings("cb-12-00000000"),
      "--append-system-prompt",
      "Be brief.",
      "--max-budget-usd",
      "5",
      "--plugin-dir",
      "/p",
      "Print hello, then stop.",
    ]);
  });

  test("env and statusFile reach the settings JSON", () => {
    const argv = buildArgv("r", {
      ...BASE,
      env: { COMPOSE_PROJECT_NAME: "marshall-1" },
      statusFile: "/s/implement.json",
    });
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1] as string);
    expect(settings.env.COMPOSE_PROJECT_NAME).toBe("marshall-1");
    expect(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toContain("fable");
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("'/s/implement.json'");
    expect(settings.hooks.SessionEnd[0].hooks[0].command).not.toContain("implement.json");
  });

  test("optional flags are omitted when unset", () => {
    const argv = buildArgv("r", BASE);
    for (const flag of ["--effort", "--append-system-prompt", "--max-budget-usd", "--resume"]) {
      expect(argv).not.toContain(flag);
    }
    expect(argv.at(-1)).toBe(BASE.prompt);
  });
});

describe("launch", () => {
  test("spawns claude --bg in cwd, records the job id, and creates the events dir", async () => {
    setFakeNextId(env, "abcd1234");
    const run = await launch(env.db, { ...BASE, effort: "medium" });
    expect(run.jobId).toBe("abcd1234");
    expect(run.state).toBe("running");
    expect(run.sessionId).toBeNull();
    expect(run.runId).toMatch(/^cb-12-[0-9a-f]{8}$/);
    expect(getRun(env.db, run.runId)).toEqual(run);
    expect(existsSync(eventsDir())).toBe(true);

    const [argv] = fakeCalls(env);
    expect(argv).toEqual(buildArgv(run.runId, { ...BASE, effort: "medium" }));
    const settings = JSON.parse(argv?.[argv.indexOf("--settings") + 1] as string);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(`${run.runId}.jsonl`);
  });

  test("non-zero exit → RunnerError and the run is marked failed", async () => {
    process.env.FAKE_CLAUDE_FAIL = "1";
    await expect(launch(env.db, BASE)).rejects.toBeInstanceOf(RunnerError);
    const runs = env.db.query<{ state: string; error: string }, []>("SELECT * FROM runs").all();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("failed");
    expect(runs[0]?.error).toBe("launch_failed");
  });
});

describe("resume", () => {
  test("passes --resume and records resumed_from; the new session id comes later", async () => {
    const run = await resume(env.db, {
      name: "CB-12",
      cwd: "/tmp",
      prompt: "Continue.",
      sessionId: "sess-1",
    });
    expect(run.resumedFrom).toBe("sess-1");
    expect(run.sessionId).toBeNull();
    expect(run.jobId).toBe("fa4e0001");
    const [argv] = fakeCalls(env);
    expect(argv?.slice(0, 5)).toEqual(["--bg", "--name", "CB-12", "--resume", "sess-1"]);
    expect(argv).not.toContain("--model");
    expect(argv?.at(-1)).toBe("Continue.");
  });

  test("an empty session id is rejected before anything is spawned", async () => {
    await expect(
      resume(env.db, { name: "CB-12", cwd: "/tmp", prompt: "x", sessionId: "" }),
    ).rejects.toBeInstanceOf(RunnerError);
    expect(fakeCalls(env)).toEqual([]);
  });
});

describe("kill", () => {
  test("stops the job and marks the run killed; a second kill is a no-op", async () => {
    const run = await launch(env.db, BASE);
    const killed = await kill(env.db, run.runId);
    expect(killed.state).toBe("killed");
    expect(killed.finishedAt).not.toBeNull();
    expect(fakeStops(env)).toEqual(["fa4e0001"]);
    await kill(env.db, run.runId);
    expect(fakeStops(env)).toEqual(["fa4e0001"]);
  });

  test("unknown run throws", async () => {
    await expect(kill(env.db, "nope")).rejects.toBeInstanceOf(RunnerError);
  });
});
