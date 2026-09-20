// Last edited: 2026-09-19 22:55 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { claudeBin, runClaude } from "../../src/runner/claude.ts";
import { RunnerError } from "../../src/runner/types.ts";
import { FAKE_CLAUDE, type RunnerEnv, useRunnerEnv } from "./helpers.ts";

let env: RunnerEnv;
let previousPath: string | undefined;

beforeEach(() => {
  env = useRunnerEnv();
  previousPath = process.env.PATH;
});

afterEach(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  env.restore();
});

describe("claudeBin", () => {
  test("MARSHALL_CLAUDE_BIN wins", () => {
    expect(claudeBin()).toBe(FAKE_CLAUDE);
  });

  test("skips cmux shim directories on PATH and takes the next claude", () => {
    delete process.env.MARSHALL_CLAUDE_BIN;
    const shim = join(env.home.dir, "cmux-cli-shims", "x");
    const real = join(env.home.dir, "bin");
    for (const dir of [shim, real]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "claude"), "#!/bin/sh\n");
      chmodSync(join(dir, "claude"), 0o755);
    }
    process.env.PATH = [shim, real].join(delimiter);
    expect(claudeBin()).toBe(join(real, "claude"));
  });

  test("falls back to the bare name when nothing is found", () => {
    delete process.env.MARSHALL_CLAUDE_BIN;
    process.env.PATH = join(env.home.dir, "empty");
    expect(claudeBin()).toBe("claude");
  });
});

describe("runClaude", () => {
  test("returns stdout on success", async () => {
    expect(await runClaude(["agents", "--json", "--all"])).toContain("[]");
  });

  test("non-zero exit → RunnerError with stderr", async () => {
    process.env.FAKE_CLAUDE_FAIL = "1";
    await expect(runClaude(["agents"])).rejects.toThrow(/exited 3: fake-claude: forced failure/);
    await expect(runClaude(["agents"])).rejects.toBeInstanceOf(RunnerError);
  });

  test("timeout → RunnerError", async () => {
    process.env.MARSHALL_CLAUDE_BIN = "/bin/sleep";
    await expect(runClaude(["5"], { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });
});
