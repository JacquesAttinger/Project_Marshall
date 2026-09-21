// Last edited: 2026-09-21 02:15 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { implementStatusPath } from "../../src/implement/status.ts";
import { discardImplementWork } from "../../src/master/git.ts";
import { prepareBounceStatus, readImplementOutcome } from "../../src/phases/status.ts";
import { type TempHome, useTempHome } from "../helpers.ts";
import { writeStatus } from "../master/helpers.ts";

let home: TempHome;

beforeEach(() => {
  home = useTempHome("marshall-status-");
});

afterEach(() => {
  home.restore();
});

describe("readImplementOutcome", () => {
  test("no file, no outcome, malformed, and a finished status", () => {
    expect(readImplementOutcome("CB-1")).toMatchObject({ ok: false, reason: "no_status" });
    writeStatus("CB-1", { outcome: null, phase: "fixing" });
    expect(readImplementOutcome("CB-1")).toMatchObject({ ok: false, reason: "no_outcome" });
    writeFileSync(implementStatusPath("CB-1"), "{not json");
    expect(readImplementOutcome("CB-1")).toMatchObject({ ok: false, reason: "malformed" });
    writeStatus("CB-1", { outcome: "tests_red", reason: "pytest" });
    expect(readImplementOutcome("CB-1")).toMatchObject({ ok: true, outcome: "tests_red" });
  });
});

describe("writeImplementResumeStatus / prepareBounceStatus", () => {
  test("keeps the PR, branch, follow-ups, and notes; resets the loop and the block counter", () => {
    writeStatus("CB-1", { cycle: 3, reviewNotes: ["disputed: x"], prDraft: true });
    writeFileSync(`${implementStatusPath("CB-1")}.stop-blocks`, "3");
    expect(prepareBounceStatus("CB-1", new Date("2026-09-20T20:00:00Z"))).toBe(true);
    const status = JSON.parse(readFileSync(implementStatusPath("CB-1"), "utf8"));
    expect(status).toMatchObject({
      outcome: null,
      reason: null,
      phase: "starting",
      cycle: 0,
      ciState: null,
      prDraft: false,
      reviewNotes: ["disputed: x"],
      followups: [{ title: "Mirror the queen-side test", body: "Same path, other rook." }],
      updatedAt: "2026-09-20T20:00:00.000Z",
    });
    expect(status.prUrl).toMatch(/pull\/12/);
    expect(existsSync(`${implementStatusPath("CB-1")}.stop-blocks`)).toBe(false);
  });

  test("prepareBounceStatus leaves a missing or unfinished file alone", () => {
    expect(prepareBounceStatus("CB-1")).toBe(false);
    writeStatus("CB-1", { outcome: null });
    expect(prepareBounceStatus("CB-1")).toBe(false);
  });
});

describe("discardImplementWork", () => {
  const calls: string[] = [];
  const git = {
    fetch: async () => {},
    head: async () => "head",
    subject: async () => "",
    lastCommitTouching: async (_cwd: string, path: string) => {
      calls.push(`last:${path}`);
      return "plansha";
    },
    resetHard: async (_cwd: string, ref: string) => {
      calls.push(`reset:${ref}`);
    },
    rebase: async () => true,
    abortRebase: async () => {},
    forcePush: async () => {
      calls.push("push");
    },
  };

  test("resets to the plan commit, pushes, and drops implement.json when there is no PR", async () => {
    calls.length = 0;
    writeStatus("CB-1", { outcome: null, prUrl: null });
    const target = await discardImplementWork({
      git,
      cwd: "/wt",
      identifier: "CB-1",
      planPath: "docs/p.md",
    });
    expect(target).toBe("plansha");
    expect(calls).toEqual(["last:docs/p.md", "reset:plansha", "push"]);
    expect(existsSync(implementStatusPath("CB-1"))).toBe(false);
  });

  test("keeps implement.json as a resume point when a PR exists", async () => {
    writeStatus("CB-1", { outcome: null, cycle: 2 });
    await discardImplementWork({ git, cwd: "/wt", identifier: "CB-1", planPath: "docs/p.md" });
    const status = JSON.parse(readFileSync(implementStatusPath("CB-1"), "utf8"));
    expect(status).toMatchObject({ outcome: null, cycle: 0, phase: "starting" });
    expect(status.prUrl).toMatch(/pull\/12/);
  });
});
