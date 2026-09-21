// Last edited: 2026-09-21 15:10 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setPause } from "../../src/caps.ts";
import { dispatch } from "../../src/cli/index.ts";
import { collectQueue, formatQueue } from "../../src/cli/queue.ts";
import { tick } from "../../src/scheduler/tick.ts";
import { type TempHome, useTempConfig, useTempHome } from "../helpers.ts";
import { pickable } from "./fake-client.ts";
import { type Harness, makeHarness, NOW, seedClaim } from "./helpers.ts";

let h: Harness;

afterEach(() => {
  h?.close();
});

const issues = () => [
  pickable({ identifier: "CB-1", priority: 3, createdAt: "2026-09-01T00:00:00.000Z" }),
  pickable({ identifier: "CB-2", priority: 1, createdAt: "2026-09-05T00:00:00.000Z" }),
  pickable({ identifier: "CB-3", priority: 0, createdAt: "2026-09-02T00:00:00.000Z" }),
  pickable({ identifier: "CB-4", priority: 3, createdAt: "2026-09-03T00:00:00.000Z" }),
];

describe("collectQueue", () => {
  test("matches what the next tick does: same order, same starts, same reasons", async () => {
    h = makeHarness({ issues: issues() });
    const report = await collectQueue(h.deps);
    expect(report.rows.map((r) => [r.identifier, r.wouldStart, r.slot])).toEqual([
      ["CB-2", true, 0],
      ["CB-1", true, 1],
      ["CB-4", false, null],
      ["CB-3", false, null],
    ]);
    const freesAt = new Date(NOW.getTime() + 5 * 3_600_000).toISOString();
    expect(report.rows[2]?.reasons).toEqual([
      "concurrency: 2 of 2 agents busy",
      `window: 2 of 2 starts in the last 5 h (next slot at ${freesAt})`,
    ]);
    expect(h.linear.calls.map((c) => c.method)).toEqual(["listPickable"]);
    expect(h.db.query("SELECT COUNT(*) AS n FROM claims").get()).toEqual({ n: 0 });

    const real = await tick(h.deps);
    expect(real.decisions.map((d) => [d.identifier, d.action === "started"])).toEqual(
      report.rows.map((r) => [r.identifier, r.wouldStart]),
    );
    expect(real.decisions.map((d) => d.detail ?? [])).toEqual(report.rows.map((r) => r.reasons));
  });

  test("shows bounces, blocked, live, and unblocked rows with their reasons", async () => {
    h = makeHarness({ issues: issues() });
    seedClaim(h.db, { issueId: "issue-2", slot: 0, state: "implementing", branch: "b" });
    seedClaim(h.db, { issueId: "issue-1", slot: 1, state: "released", branch: "b1", bounces: 3 });
    seedClaim(h.db, { issueId: "issue-4", slot: 1, state: "blocked", branch: "b4", bounces: 3 });
    seedClaim(h.db, { issueId: "issue-3", slot: 1, state: "released", branch: "b3", bounces: 1 });
    for (let i = 0; i < 6; i++) {
      h.db.run("INSERT INTO starts (issue_id, started_at) VALUES (?, ?)", [
        `x${i}`,
        NOW.toISOString(),
      ]);
    }
    const report = await collectQueue(h.deps);
    expect(report.counts).toMatchObject({ live: 1, today: 6, window: 6 });
    expect(report.rows.map((r) => [r.identifier, r.kind, r.wouldStart, r.reasons])).toEqual([
      [
        "CB-2",
        "live",
        false,
        ["claim row is still live (implementing); step 08 must release it first"],
      ],
      ["CB-1", "blocked", false, ["bounce limit: 3 of 3; the next tick marks it Blocked"]],
      ["CB-4", "bounce", true, ["moved out of Blocked by a human: bounce budget resets"]],
      ["CB-3", "bounce", false, ["concurrency: 2 of 2 agents busy"]],
    ]);
    // The daily and window caps do not apply to bounces; the one free slot goes to CB-4.
    expect(report.rows.map((r) => r.slot)).toEqual([null, null, 1, null]);
  });

  test("reports the pause and the window opening time", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1" })] });
    const until = new Date(NOW.getTime() + 3_600_000);
    setPause(h.db, until);
    const report = await collectQueue(h.deps);
    expect(report.pausedUntil).toBe(until.toISOString());
    expect(report.rows[0]?.reasons).toEqual([`paused until ${until.toISOString()}`]);
  });
});

describe("collectQueue: human-only label", () => {
  test("shows a human-only issue as wouldStart false, ahead of every other check", async () => {
    h = makeHarness({
      issues: [pickable({ identifier: "CB-1", labels: ["human-only"] })],
    });
    seedClaim(h.db, { issueId: "issue-1", slot: 0, state: "blocked", branch: "b", bounces: 9 });
    const report = await collectQueue(h.deps);
    expect(report.rows).toMatchObject([
      {
        identifier: "CB-1",
        kind: "human_only",
        wouldStart: false,
        reasons: ["human-only label: Marshall never picks this up"],
      },
    ]);
  });
});

describe("formatQueue", () => {
  test("prints the header, the caps line, and one aligned row per issue", async () => {
    h = makeHarness({ issues: issues().slice(0, 3) });
    seedClaim(h.db, { issueId: "issue-3", slot: 1, state: "released", branch: "b3", bounces: 1 });
    const text = formatQueue(await collectQueue(h.deps));
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Now ${NOW.toISOString()}`);
    expect(lines[1]).toBe("Agents 0/2 busy · starts today 0/6 · last 5 h 0/2");
    expect(lines[3]).toMatch(/^#\s+Issue\s+Priority\s+Created\s+Kind\s+Next tick\s+Why$/);
    expect(lines[4]).toMatch(/^1\s+CB-2\s+Urgent\s+2026-09-05\s+fresh\s+start \(slot 0\)$/);
    expect(lines[5]).toMatch(/^2\s+CB-1\s+Medium\s+2026-09-01\s+fresh\s+start \(slot 1\)$/);
    expect(lines[6]).toMatch(
      /^3\s+CB-3\s+None\s+2026-09-02\s+bounce #2\s+wait\s+concurrency: 2 of 2 agents busy$/,
    );
    expect(lines).toHaveLength(7);
  });

  test("says so when nothing is pickable, and shows the pause", async () => {
    h = makeHarness();
    setPause(h.db, new Date(NOW.getTime() + 60_000));
    const text = formatQueue(await collectQueue(h.deps));
    expect(text).toContain("PAUSED until");
    expect(text.endsWith("Nothing pickable.")).toBe(true);
  });
});

describe("marshall queue", () => {
  let home: TempHome;
  let previousKey: string | undefined;

  beforeEach(() => {
    home = useTempHome();
    useTempConfig(home);
    previousKey = process.env.MARSHALL_LINEAR_API_KEY;
    delete process.env.MARSHALL_LINEAR_API_KEY;
  });

  afterEach(() => {
    if (previousKey !== undefined) process.env.MARSHALL_LINEAR_API_KEY = previousKey;
    home.restore();
  });

  test("takes no positionals and fails before any request without a key", async () => {
    expect(await dispatch(["queue", "extra"])).toBe(2);
    await expect(dispatch(["queue"])).rejects.toThrow(/MARSHALL_LINEAR_API_KEY is not set/);
  });
});
