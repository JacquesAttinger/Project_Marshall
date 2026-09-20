// Last edited: 2026-09-20 16:25 CDT
// Hand-off test setup: the fake gh shim, a PR body it serves, an implement.json to read from,
// and a recording Linear stub.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ImplementStatus, implementStatusPath } from "../../src/implement/status.ts";
import type { LinearClient } from "../../src/linear/index.ts";

export const FAKE_GH = resolve(import.meta.dir, "..", "fixtures", "fake-gh");
export const HANDOFF_FIXTURES = resolve(import.meta.dir, "..", "fixtures", "handoffs");
export const PR_BODY_FIXTURES = resolve(import.meta.dir, "..", "fixtures", "pr_bodies");

export const PR_URL = "https://github.com/example/chessbuddy/pull/12";
export const BRANCH = "cb-12-fix-castling-through-check";

const ENV_KEYS = ["MARSHALL_GH_BIN", "FAKE_GH_DIR", "FAKE_GH_FAIL"];

export interface GhEnv {
  dir: string;
  restore(): void;
}

/** Point MARSHALL_GH_BIN at the shim with a fresh FAKE_GH_DIR. Call `restore()` in afterEach. */
export function useGhEnv(): GhEnv {
  const previous = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const dir = mkdtempSync(join(tmpdir(), "marshall-gh-"));
  process.env.MARSHALL_GH_BIN = FAKE_GH;
  process.env.FAKE_GH_DIR = dir;
  delete process.env.FAKE_GH_FAIL;
  return {
    dir,
    restore() {
      for (const [k, v] of previous) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every fake-gh argv, in order. */
export function ghCalls(env: GhEnv): string[][] {
  try {
    return readFileSync(join(env.dir, "calls.log"), "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as string[]);
  } catch {
    return [];
  }
}

export function setPrBody(env: GhEnv, text: string): void {
  writeFileSync(join(env.dir, "pr_body.md"), text);
}

export function prBody(env: GhEnv): string {
  return readFileSync(join(env.dir, "pr_body.md"), "utf8");
}

export function prBodyFixture(name: string): string {
  return readFileSync(join(PR_BODY_FIXTURES, `${name}.md`), "utf8");
}

export function handoffFixture(name: string): string {
  return readFileSync(join(HANDOFF_FIXTURES, `${name}.md`), "utf8");
}

/** A finished implement.json under the temp MARSHALL_HOME, `pr_green` unless overridden. */
export function writeImplementStatus(
  issueId: string,
  overrides: Partial<ImplementStatus> = {},
): string {
  const status: ImplementStatus = {
    issueId,
    slot: 0,
    phase: "done",
    cycle: 1,
    maxCycles: 4,
    branch: BRANCH,
    prUrl: PR_URL,
    prDraft: false,
    ciState: "green",
    outcome: "pr_green",
    reason: null,
    followups: [{ title: "Mirror the queen-side test", body: "Same path, other rook." }],
    reviewNotes: [],
    updatedAt: "2026-09-20T17:00:00Z",
    ...overrides,
  };
  const path = implementStatusPath(issueId);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(status, null, 2));
  return path;
}

export interface LinearStub {
  linear: Pick<LinearClient, "comment" | "updateComment">;
  comments: { issueId: string; body: string }[];
  updates: { commentId: string; body: string }[];
  /** Set to make the next Linear call throw. */
  fail?: string;
}

export function fakeLinearStub(): LinearStub {
  const stub: LinearStub = { comments: [], updates: [], linear: null as never };
  let n = 0;
  stub.linear = {
    comment: async (issueId, body) => {
      if (stub.fail) throw new Error(stub.fail);
      stub.comments.push({ issueId, body });
      n += 1;
      return { id: `comment-${n}` };
    },
    updateComment: async (commentId, body) => {
      if (stub.fail) throw new Error(stub.fail);
      stub.updates.push({ commentId, body });
    },
  };
  return stub;
}
