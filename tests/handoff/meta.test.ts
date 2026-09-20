// Last edited: 2026-09-20 16:25 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readHandoffMeta, writeHandoffMeta } from "../../src/handoff/meta.ts";
import { HandoffError } from "../../src/handoff/types.ts";
import { handoffMetaPath } from "../../src/paths.ts";
import { type TempHome, useTempHome } from "../helpers.ts";

let home: TempHome;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  home.restore();
});

const META = {
  issueId: "CB-12",
  commentId: "comment-1",
  round: 1,
  prUrl: "https://github.com/example/chessbuddy/pull/12",
  postedAt: "2026-09-20T17:00:00.000Z",
};

describe("hand-off sidecar", () => {
  test("absent → null", () => {
    expect(readHandoffMeta("CB-12")).toBeNull();
  });

  test("round-trips, creating the handoffs dir, with no temp file left behind", () => {
    const path = writeHandoffMeta("CB-12", META);
    expect(path).toBe(join(home.dir, "handoffs", "CB-12.json"));
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readHandoffMeta("CB-12")).toEqual(META);
    writeHandoffMeta("CB-12", { ...META, round: 2, badge: "rebased after x" });
    expect(readHandoffMeta("CB-12")).toEqual({ ...META, round: 2, badge: "rebased after x" });
  });

  test("malformed JSON or an unknown key → HandoffError", () => {
    mkdirSync(join(home.dir, "handoffs"), { recursive: true });
    writeFileSync(handoffMetaPath("CB-12"), "{ nope");
    expect(() => readHandoffMeta("CB-12")).toThrow(HandoffError);
    writeFileSync(handoffMetaPath("CB-12"), JSON.stringify({ ...META, extra: 1 }));
    expect(() => readHandoffMeta("CB-12")).toThrow(/extra/);
    writeFileSync(handoffMetaPath("CB-12"), JSON.stringify({ ...META, round: 0 }));
    expect(() => readHandoffMeta("CB-12")).toThrow(/round/);
  });
});
