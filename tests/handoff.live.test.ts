// Last edited: 2026-09-20 17:10 CDT
// Live hand-off writer test: the real `claude` and `gh` against a real worktree whose PR is open.
// Skipped unless MARSHALL_LIVE=1 and MARSHALL_LIVE_HANDOFF_CWD points at that worktree.
// Run: MARSHALL_LIVE=1 MARSHALL_LIVE_HANDOFF_CWD=~/code/ChessBuddy-che-5 bun test tests/handoff.live.test.ts
// Seeds a temp MARSHALL_HOME with the recorded step 05 implement.json (CHE-5). Nothing is posted.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig } from "../src/config.ts";
import { migrate, openDb } from "../src/db/index.ts";
import { writeHandoff } from "../src/handoff/phase.ts";
import { checkHandoffFile } from "../src/handoff/validate.ts";
import { implementStatusPath } from "../src/implement/status.ts";
import { ensureHome, expandTilde, issueDir } from "../src/paths.ts";
import { createRunWaiter } from "../src/plan/wait.ts";
import { type TempHome, useTempHome } from "./helpers.ts";
import { sampleIssue } from "./plan/helpers.ts";

const CWD = process.env.MARSHALL_LIVE_HANDOFF_CWD;
const LIVE = process.env.MARSHALL_LIVE === "1" && !!CWD;
const live = test.skipIf(!LIVE);
const ISSUE = process.env.MARSHALL_LIVE_HANDOFF_ISSUE ?? "CHE-5";
const PLAN = process.env.MARSHALL_LIVE_HANDOFF_PLAN ?? "docs/health_version_plan.md";
const STATUS = resolve(import.meta.dir, "..", "docs", "examples", "step05_CHE-5", "implement.json");
const LIMIT_MS = 10 * 60_000;
const TEST_TIMEOUT_MS = LIMIT_MS + 60_000;

let home: TempHome;

beforeAll(() => {
  if (LIVE) home = useTempHome("marshall-handoff-live-");
});

afterAll(() => {
  if (LIVE) home.restore();
});

live(
  "writes a valid hand-off for the CHE-5 worktree in under 10 minutes, posting nothing",
  async () => {
    const cwd = resolve(expandTilde(CWD as string));
    expect(existsSync(cwd)).toBe(true);
    ensureHome();
    mkdirSync(issueDir(ISSUE), { recursive: true });
    copyFileSync(STATUS, implementStatusPath(ISSUE));
    const db = openDb(":memory:");
    migrate(db);
    const waiter = createRunWaiter(db);
    const config = parseConfig({
      workspace: "chessbuddy",
      teamId: "t",
      repoPath: home.dir,
      handoffMinutes: 10,
    });
    const started = Date.now();
    try {
      const result = await writeHandoff({
        db,
        config,
        issue: sampleIssue({
          identifier: ISSUE,
          url: `https://linear.app/chessbuddy/issue/${ISSUE}`,
        }),
        cwd,
        planPath: PLAN,
        waiter,
        onLaunched: (run) => console.log(`launched ${run.runId} (job ${run.jobId})`),
      });
      const elapsed = Date.now() - started;
      console.log(`writeHandoff → ${JSON.stringify(result)} in ${Math.round(elapsed / 1000)} s`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(elapsed).toBeLessThan(LIMIT_MS);
      const check = checkHandoffFile(result.handoffPath, {
        prUrl: result.prUrl,
        branch: result.branch,
      });
      expect(check.problems).toEqual([]);
      const text = readFileSync(result.handoffPath, "utf8");
      expect(text).toContain("## Verification recipe");
      if (process.env.MARSHALL_LIVE_REPORT) {
        copyFileSync(result.handoffPath, expandTilde(process.env.MARSHALL_LIVE_REPORT));
      }
    } finally {
      waiter.stop();
      db.close();
    }
  },
  TEST_TIMEOUT_MS,
);
