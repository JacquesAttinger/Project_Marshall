// Last edited: 2026-09-20 10:56 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../../src/config.ts";
import {
  classifierArgv,
  classifierPrompt,
  classifyIssue,
  modelFor,
  parseClassifierOutput,
} from "../../src/plan/classify.ts";
import { PlanError } from "../../src/plan/types.ts";
import { fakeCalls, type RunnerEnv, setFakePrint, useRunnerEnv } from "../runner/helpers.ts";
import { issueFixtures, sampleIssue } from "./helpers.ts";

let env: RunnerEnv;

beforeEach(() => {
  env = useRunnerEnv();
});

afterEach(() => {
  env.restore();
});

describe("classifierPrompt / classifierArgv", () => {
  test("prompt carries the fields and nothing from the repo", () => {
    const prompt = classifierPrompt(sampleIssue({ comments: [] }));
    expect(prompt).toContain("Title: Fix castling through check");
    expect(prompt).toContain("Priority: High");
    expect(prompt).toContain("Labels: bug");
    expect(prompt).toContain("Comments: 0");
    expect(prompt).toContain("The king can castle while the square it crosses is attacked.");
    expect(classifierPrompt(sampleIssue({ description: null, labels: [] }))).toContain(
      "Labels: (none)\nComments: 0\n\nDescription:\n(no description)",
    );
  });

  test("argv is exactly as documented", () => {
    const argv = classifierArgv("PROMPT", "haiku");
    expect(argv.slice(0, 5)).toEqual(["-p", "--model", "haiku", "--output-format", "json"]);
    expect(argv[5]).toBe("--json-schema");
    const schema = JSON.parse(argv[6] as string);
    expect(schema.$schema).toBeUndefined();
    expect(schema.properties.complexity.enum).toEqual(["simple", "complex"]);
    expect(schema.required).toEqual(["complexity", "reason"]);
    expect(schema.additionalProperties).toBe(false);
    expect(argv.slice(7)).toEqual([
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "project,local",
      "PROMPT",
    ]);
  });

  test("the five fixtures each produce a prompt", () => {
    const fixtures = issueFixtures();
    expect(fixtures).toHaveLength(5);
    for (const f of fixtures)
      expect(classifierPrompt(f.issue)).toContain(`Title: ${f.issue.title}`);
  });
});

describe("parseClassifierOutput", () => {
  test("reads structured_output first", () => {
    const out = JSON.stringify({
      type: "result",
      result: '{"complexity":"simple","reason":"r"}',
      structured_output: { complexity: "complex", reason: "from schema" },
    });
    expect(parseClassifierOutput(out)).toEqual({ complexity: "complex", reason: "from schema" });
  });

  test("falls back to result as JSON text, then to a bare object", () => {
    expect(
      parseClassifierOutput(JSON.stringify({ result: '{"complexity":"simple","reason":"r"}' })),
    ).toEqual({ complexity: "simple", reason: "r" });
    expect(parseClassifierOutput('{"complexity":"complex","reason":"bare"}')).toEqual({
      complexity: "complex",
      reason: "bare",
    });
  });

  test("garbage, an error envelope, and a bad complexity each throw PlanError", () => {
    for (const bad of [
      "not json",
      JSON.stringify({ is_error: true, result: "rate limited" }),
      JSON.stringify({ structured_output: { complexity: "medium", reason: "x" } }),
      JSON.stringify({ result: "I think it is simple." }),
    ]) {
      expect(() => parseClassifierOutput(bad)).toThrow(PlanError);
    }
  });
});

describe("classifyIssue", () => {
  test("runs claude -p from MARSHALL_HOME with the model and returns the canned answer", async () => {
    const result = await classifyIssue(sampleIssue(), { model: "haiku" });
    expect(result).toEqual({ complexity: "simple", reason: "canned" });
    const [argv] = fakeCalls(env);
    expect(argv?.slice(0, 3)).toEqual(["-p", "--model", "haiku"]);
    const calls = readFileSync(join(env.fakeDir, "calls.log"), "utf8");
    // macOS tmpdir is a symlink; the shim prints the real path.
    expect(calls).toContain(`cwd=${realpathSync(env.home.dir)}`);
  });

  test("a bad answer → PlanError classifier_bad_output", async () => {
    setFakePrint(env, { structured_output: { complexity: "huge", reason: "x" } });
    const err = await classifyIssue(sampleIssue()).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.code).toBe("classifier_bad_output");
  });

  test("a non-zero exit → PlanError classifier_failed", async () => {
    process.env.FAKE_CLAUDE_FAIL = "1";
    const err = await classifyIssue(sampleIssue()).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.code).toBe("classifier_failed");
  });

  test("a hung classifier times out", async () => {
    setFakePrint(env, "");
    process.env.FAKE_CLAUDE_PLAN_SCRIPT = "";
    const err = await classifyIssue(sampleIssue(), { timeoutMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(["classifier_failed", "classifier_bad_output"]).toContain(err.code);
  });
});

describe("modelFor", () => {
  test("maps complexity to the configured planner models", () => {
    const config = parseConfig({
      workspace: "w",
      teamId: "t",
      repoPath: env.home.dir,
      models: { planSimple: "opus", planComplex: "fable" },
    });
    expect(modelFor({ complexity: "simple", reason: "" }, config)).toBe("opus");
    expect(modelFor({ complexity: "complex", reason: "" }, config)).toBe("fable");
  });
});
