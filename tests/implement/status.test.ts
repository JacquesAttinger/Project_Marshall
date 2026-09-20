// Last edited: 2026-09-20 10:45 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ImplementStatusError,
  implementStatusPath,
  isImplementFinished,
  parseImplementStatus,
  readImplementStatus,
} from "../../src/implement/status.ts";
import { ensureHome, issueDir } from "../../src/paths.ts";
import { type TempHome, useTempHome } from "../helpers.ts";

let home: TempHome;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  home.restore();
});

/** The file as the skill writes it right after opening the PR. */
function sample() {
  return {
    issueId: "CB-12",
    slot: 0,
    phase: "pr_open",
    cycle: 0,
    maxCycles: 4,
    branch: "feat/cb-12-thing",
    prUrl: "https://github.com/dvairus/ChessBuddy/pull/99",
    prDraft: false,
    ciState: "pending",
    outcome: null,
    reason: null,
    followups: [{ title: "Rename the queue", body: "Found while reading worker/main.py." }],
    reviewNotes: ["PLAUSIBLE: retry loop may double-count on timeout"],
    updatedAt: "2026-09-20T15:00:00.000Z",
  };
}

describe("parseImplementStatus", () => {
  test("a valid object round-trips and is not finished", () => {
    const status = parseImplementStatus(sample());
    expect(status.issueId).toBe("CB-12");
    expect(status.followups[0]?.title).toBe("Rename the queue");
    expect(isImplementFinished(status)).toBe(false);
  });

  test("a bad outcome is rejected and the key is named", () => {
    expect(() => parseImplementStatus({ ...sample(), outcome: "REVIEW_EXHAUSTED" })).toThrow(
      ImplementStatusError,
    );
    expect(() => parseImplementStatus({ ...sample(), outcome: "REVIEW_EXHAUSTED" })).toThrow(
      /outcome/,
    );
  });

  test("a bad phase, an unknown key, and a non-ISO timestamp are rejected", () => {
    expect(() => parseImplementStatus({ ...sample(), phase: "review" })).toThrow(/phase/);
    expect(() => parseImplementStatus({ ...sample(), status: "x" })).toThrow(/status/);
    expect(() => parseImplementStatus({ ...sample(), updatedAt: "yesterday" })).toThrow(
      /updatedAt/,
    );
  });

  test("a finished run has a non-null outcome", () => {
    const status = parseImplementStatus({
      ...sample(),
      phase: "done",
      cycle: 4,
      prDraft: true,
      outcome: "review_exhausted",
      reason: "4 cycles; still open: null deref in worker/main.py",
    });
    expect(isImplementFinished(status)).toBe(true);
  });
});

describe("readImplementStatus", () => {
  test("null before the skill writes anything", () => {
    ensureHome();
    expect(readImplementStatus("CB-12")).toBeNull();
  });

  test("reads the file from <MARSHALL_HOME>/issues/<id>/implement.json", () => {
    const path = implementStatusPath("CB-12");
    expect(path).toBe(join(home.dir, "issues", "CB-12", "implement.json"));
    mkdirSync(issueDir("CB-12"), { recursive: true });
    writeFileSync(path, JSON.stringify(sample()));
    expect(readImplementStatus("CB-12")?.prUrl).toContain("/pull/99");
  });

  test("a malformed file throws instead of returning null", () => {
    mkdirSync(issueDir("CB-13"), { recursive: true });
    writeFileSync(implementStatusPath("CB-13"), "{not json");
    expect(() => readImplementStatus("CB-13")).toThrow(ImplementStatusError);
  });
});
