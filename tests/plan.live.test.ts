// Last edited: 2026-09-20 13:00 CDT
// Live classifier test against the real Haiku. Skipped unless MARSHALL_LIVE=1.
// Run: MARSHALL_LIVE=1 bun test tests/plan.live.test.ts
// Uses the real `claude` login and a temp MARSHALL_HOME as the classifier's cwd.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { ClassificationSchema, classifyIssue } from "../src/plan/index.ts";
import { type TempHome, useTempHome } from "./helpers.ts";
import { issueFixtures } from "./plan/helpers.ts";

const LIVE = process.env.MARSHALL_LIVE === "1";
const live = test.skipIf(!LIVE);
const MODEL = process.env.MARSHALL_LIVE_MODEL ?? "haiku";
const LIMIT_MS = 10_000;
/** bun's default per-test timeout is 5 s; a live call takes 4–6 s. */
const TEST_TIMEOUT_MS = 30_000;

let home: TempHome;
const agreement: string[] = [];

beforeAll(() => {
  if (LIVE) home = useTempHome("marshall-plan-live-");
});

afterAll(() => {
  if (LIVE) home.restore();
  if (agreement.length > 0) console.log(`classifier vs expected:\n${agreement.join("\n")}`);
});

for (const fixture of issueFixtures()) {
  live(
    `${fixture.name}: valid classification in under ${LIMIT_MS / 1000} s`,
    async () => {
      const started = Date.now();
      const result = await classifyIssue(fixture.issue, { model: MODEL });
      const ms = Date.now() - started;
      expect(ClassificationSchema.safeParse(result).success).toBe(true);
      expect(ms).toBeLessThan(LIMIT_MS);
      const mark = result.complexity === fixture.expected ? "agree" : "DIFFER";
      agreement.push(
        `${mark}  ${fixture.name}: ${result.complexity} (expected ${fixture.expected}) ${ms} ms — ${result.reason}`,
      );
    },
    TEST_TIMEOUT_MS,
  );
}
