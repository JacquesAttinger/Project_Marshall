// Last edited: 2026-09-20 15:35 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GhError, ghBin, runGh } from "../src/gh.ts";

const FAKE_GH = resolve(import.meta.dir, "fixtures", "fake-gh");
const KEYS = ["MARSHALL_GH_BIN", "FAKE_GH_DIR", "FAKE_GH_FAIL"];

let previous: Map<string, string | undefined>;
let dir: string;

beforeEach(() => {
  previous = new Map(KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), "marshall-gh-"));
  process.env.MARSHALL_GH_BIN = FAKE_GH;
  process.env.FAKE_GH_DIR = dir;
  delete process.env.FAKE_GH_FAIL;
});

afterEach(() => {
  for (const [k, v] of previous) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("ghBin", () => {
  test("MARSHALL_GH_BIN overrides, else gh", () => {
    expect(ghBin()).toBe(FAKE_GH);
    delete process.env.MARSHALL_GH_BIN;
    expect(ghBin()).toBe("gh");
    process.env.MARSHALL_GH_BIN = "";
    expect(ghBin()).toBe("gh");
  });
});

describe("runGh", () => {
  test("returns stdout untouched and logs the argv", async () => {
    writeFileSync(join(dir, "pr_body.md"), "Body line.\n");
    const out = await runGh(["pr", "view", "https://x/pull/1", "--json", "body"], dir);
    expect(JSON.parse(out)).toEqual({ body: "Body line.\n" });
    expect(out.endsWith("\n")).toBe(true);
    expect(readFileSync(join(dir, "calls.log"), "utf8").trim()).toBe(
      JSON.stringify(["pr", "view", "https://x/pull/1", "--json", "body"]),
    );
  });

  test("non-zero exit → GhError carrying stderr", async () => {
    process.env.FAKE_GH_FAIL = "1";
    const err = await runGh(["pr", "view", "x"], dir).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(GhError);
    expect(err?.message).toContain("gh pr view x exited 1: fake-gh: forced failure");
  });
});
