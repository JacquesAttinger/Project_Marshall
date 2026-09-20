// Last edited: 2026-09-20 16:25 CDT
// postHandoff against the fake gh shim and a recording Linear stub.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readHandoffMeta } from "../../src/handoff/meta.ts";
import { type PostInput, postHandoff } from "../../src/handoff/post.ts";
import { renderPackage } from "../../src/handoff/render.ts";
import { HANDOFF_END, HANDOFF_START } from "../../src/handoff/types.ts";
import { handoffPath, issueDir } from "../../src/paths.ts";
import { type TempHome, useTempHome } from "../helpers.ts";
import {
  fakeLinearStub,
  type GhEnv,
  ghCalls,
  handoffFixture,
  type LinearStub,
  PR_URL,
  prBody,
  prBodyFixture,
  setPrBody,
  useGhEnv,
} from "./helpers.ts";

let home: TempHome;
let gh: GhEnv;
let stub: LinearStub;
const NOW = new Date("2026-09-20T18:00:00Z");

beforeEach(() => {
  home = useTempHome();
  gh = useGhEnv();
  stub = fakeLinearStub();
  Bun.spawnSync(["mkdir", "-p", join(home.dir, "handoffs")]);
  writeFileSync(handoffPath("CB-12"), handoffFixture("good"));
  setPrBody(gh, prBodyFixture("fresh"));
});

afterEach(() => {
  gh.restore();
  home.restore();
});

function input(overrides: Partial<PostInput> = {}): PostInput {
  return {
    issue: { id: "issue-uuid-1", identifier: "CB-12" },
    linear: stub.linear,
    prUrl: PR_URL,
    cwd: home.dir,
    round: 1,
    now: () => NOW,
    ...overrides,
  };
}

function between(text: string): string {
  const start = text.indexOf(HANDOFF_START) + HANDOFF_START.length;
  return text.slice(start, text.indexOf(HANDOFF_END)).trim();
}

describe("postHandoff, first post", () => {
  test("creates the comment with the UUID, writes the sidecar, then views and edits the PR", async () => {
    const result = await postHandoff(input());
    expect(result).toMatchObject({
      ok: true,
      commentId: "comment-1",
      commentAction: "created",
      prAction: "replaced",
      metaPath: join(home.dir, "handoffs", "CB-12.json"),
    });
    const text = renderPackage(handoffFixture("good"));
    expect(stub.comments).toEqual([{ issueId: "issue-uuid-1", body: text }]);
    expect(stub.updates).toEqual([]);
    expect(readHandoffMeta("CB-12")).toEqual({
      issueId: "CB-12",
      commentId: "comment-1",
      round: 1,
      prUrl: PR_URL,
      postedAt: "2026-09-20T18:00:00.000Z",
    });
    expect(ghCalls(gh).map((c) => c.slice(0, 3))).toEqual([
      ["pr", "view", PR_URL],
      ["pr", "edit", PR_URL],
    ]);
    expect(between(prBody(gh))).toBe(text);
    expect(prBody(gh)).toContain("Closes https://linear.app/chessbuddy/issue/CB-12");
    expect(existsSync(join(issueDir("CB-12"), "pr_body.md"))).toBe(true);
  });

  test("an invalid file posts nothing anywhere", async () => {
    writeFileSync(handoffPath("CB-12"), handoffFixture("no_pr"));
    const result = await postHandoff(input());
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(result.ok ? "" : result.detail).toContain("has no PR URL");
    expect(stub.comments).toEqual([]);
    expect(ghCalls(gh)).toEqual([]);
    expect(readHandoffMeta("CB-12")).toBeNull();
  });

  test("a PR URL that does not match the one given is invalid", async () => {
    const result = await postHandoff(
      input({ prUrl: "https://github.com/example/chessbuddy/pull/99" }),
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(stub.comments).toEqual([]);
  });

  test("Linear failing → linear_failed, no sidecar, gh untouched", async () => {
    stub.fail = "boom";
    const result = await postHandoff(input());
    expect(result).toEqual({ ok: false, reason: "linear_failed", detail: "boom" });
    expect(readHandoffMeta("CB-12")).toBeNull();
    expect(ghCalls(gh)).toEqual([]);
  });

  test("gh failing after Linear → gh_failed, and the sidecar already holds the comment id", async () => {
    process.env.FAKE_GH_FAIL = "1";
    const result = await postHandoff(input());
    expect(result).toMatchObject({ ok: false, reason: "gh_failed" });
    expect(result.ok ? "" : result.detail).toContain("forced failure");
    expect(stub.comments).toHaveLength(1);
    expect(readHandoffMeta("CB-12")?.commentId).toBe("comment-1");
  });

  test("unbalanced markers in the PR body → markers_unbalanced, comment still posted", async () => {
    setPrBody(gh, prBodyFixture("unbalanced"));
    const result = await postHandoff(input());
    expect(result).toMatchObject({ ok: false, reason: "markers_unbalanced" });
    expect(stub.comments).toHaveLength(1);
    expect(ghCalls(gh).map((c) => c[1])).toEqual(["view"]);
  });
});

describe("postHandoff, re-post", () => {
  test("edits the same comment, bumps the round, and replaces the PR section", async () => {
    await postHandoff(input());
    writeFileSync(handoffPath("CB-12"), handoffFixture("round2"));
    const result = await postHandoff(input({ round: 2 }));
    expect(result).toMatchObject({
      ok: true,
      commentId: "comment-1",
      commentAction: "updated",
      prAction: "replaced",
    });
    expect(stub.comments).toHaveLength(1);
    expect(stub.updates).toEqual([
      { commentId: "comment-1", body: renderPackage(handoffFixture("round2")) },
    ]);
    expect(readHandoffMeta("CB-12")).toMatchObject({ round: 2, commentId: "comment-1" });
    expect(between(prBody(gh))).toContain("## Round 2 — what changed");
    expect(prBody(gh).split(HANDOFF_START)).toHaveLength(2);
  });

  test("the same text again is idempotent: comment edited, PR body left alone", async () => {
    await postHandoff(input());
    const before = prBody(gh);
    const result = await postHandoff(input());
    expect(result).toMatchObject({ ok: true, commentAction: "updated", prAction: "unchanged" });
    expect(prBody(gh)).toBe(before);
    expect(ghCalls(gh).map((c) => c[1])).toEqual(["view", "edit", "view"]);
  });

  test("a badge lands in the comment, the PR body, and the sidecar, but not in the file", async () => {
    await postHandoff(input());
    const badge = "rebased after https://github.com/example/chessbuddy/pull/1";
    const result = await postHandoff(input({ badge }));
    expect(result).toMatchObject({ ok: true, prAction: "replaced" });
    const posted = stub.updates[0]?.body as string;
    expect(posted).toContain(`\n\n_${badge}_\n\n## Where to find it`);
    expect(between(prBody(gh))).toBe(posted);
    expect(readHandoffMeta("CB-12")?.badge).toBe(badge);
    expect(handoffFixture("good")).not.toContain(badge);
  });
});
