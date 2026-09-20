// Last edited: 2026-09-20 10:56 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { priorityWord, renderBrief, writeBrief } from "../../src/plan/brief.ts";
import { type TempHome, useTempHome } from "../helpers.ts";
import { sampleIssue } from "./helpers.ts";

let home: TempHome;

beforeEach(() => {
  home = useTempHome("marshall-brief-");
});

afterEach(() => {
  home.restore();
});

const AT = "2026-09-20T16:00:00.000Z";

describe("renderBrief", () => {
  test("fresh brief: issue facts, description, and no comments", () => {
    const text = renderBrief({
      runId: "cb-12-plan-01234567",
      issue: sampleIssue(),
      mode: "fresh",
      writtenAt: AT,
    });
    expect(text).toBe(
      [
        "# CB-12 — Fix castling through check",
        "",
        "<!-- Brief written by Marshall at 2026-09-20T16:00:00.000Z for run cb-12-plan-01234567 -->",
        "",
        "## Issue",
        "",
        "- Identifier: CB-12",
        "- Title: Fix castling through check",
        "- URL: https://linear.app/chessbuddy/issue/CB-12",
        "- Priority: High",
        "- Labels: bug",
        "- Branch: cb-12-fix-castling-through-check",
        "",
        "## Description",
        "",
        "The king can castle while the square it crosses is attacked.",
        "",
        "## Comments",
        "",
        "(none)",
        "",
      ].join("\n"),
    );
  });

  test("comments are oldest first and marked You or Marshall; empty description is spelled out", () => {
    const issue = sampleIssue({
      description: null,
      labels: [],
      comments: [
        {
          id: "c1",
          body: "First thought.",
          createdAt: "2026-09-19T01:00:00Z",
          fromMarshall: false,
        },
        {
          id: "c2",
          body: "Plan posted.\n\n_— Marshall_",
          createdAt: "2026-09-19T02:00:00Z",
          fromMarshall: true,
        },
      ],
    });
    const text = renderBrief({ runId: "r", issue, mode: "fresh", writtenAt: AT });
    expect(text).toContain("- Labels: (none)");
    expect(text).toContain("## Description\n\n(no description)\n");
    expect(text).toContain(
      "### You — 2026-09-19T01:00:00Z\n\nFirst thought.\n\n### Marshall — 2026-09-19T02:00:00Z\n\nPlan posted.",
    );
    expect(text).not.toContain("## Revision");
  });
});

describe("renderBrief, revise", () => {
  test("appends the revision block with the latest human comment verbatim", () => {
    const latest = {
      id: "c3",
      body: "Use a helper, not inline.",
      createdAt: "2026-09-19T03:00:00Z",
      fromMarshall: false,
    };
    const issue = sampleIssue({ comments: [latest], latestHumanComment: latest });
    const text = renderBrief({
      runId: "r",
      issue,
      mode: "revise",
      revision: 2,
      planPath: "docs/fix-castling_plan.md",
      writtenAt: AT,
    });
    expect(
      text.endsWith(
        [
          "## Revision",
          "",
          "- Number: 2",
          "- Existing plan: docs/fix-castling_plan.md",
          "",
          "### Latest comment from you",
          "",
          "2026-09-19T03:00:00Z",
          "",
          "Use a helper, not inline.",
          "",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  test("priority words", () => {
    expect([0, 1, 2, 3, 4, 9].map(priorityWord)).toEqual([
      "None",
      "Urgent",
      "High",
      "Medium",
      "Low",
      "Unknown (9)",
    ]);
  });
});

describe("writeBrief", () => {
  test("writes <MARSHALL_HOME>/briefs/<runId>.md", () => {
    const path = writeBrief({ runId: "cb-12-plan-abcdef01", issue: sampleIssue(), mode: "fresh" });
    expect(path).toBe(join(home.dir, "briefs", "cb-12-plan-abcdef01.md"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("# CB-12 — Fix castling through check");
  });
});
