// Last edited: 2026-09-21 01:30 CDT
// The step 09 commands through `dispatch` and their modules: pause/resume flags, the kill flag with
// a live orchestrator (this test process stands in via the pidfile), logs with an injected exec,
// notify test with an injected fetch, and the arity rules. Nothing here touches launchd or Linear.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { manualPauseAt, setPause } from "../src/caps.ts";
import { dispatch } from "../src/cli/index.ts";
import { runLogs } from "../src/cli/logs.ts";
import { runNotifyTest, sampleRow } from "../src/cli/notify.ts";
import { migrate, openDb } from "../src/db/index.ts";
import { killFlag } from "../src/master/types.ts";
import type { Fetch } from "../src/notify.ts";
import { dbPath, logPath } from "../src/paths.ts";
import { writePidfile } from "../src/pidfile.ts";
import { insertRun, updateRun } from "../src/runner/store.ts";
import { getFlag } from "../src/scheduler/store.ts";
import { type TempHome, useTempConfig, useTempHome } from "./helpers.ts";
import { seedClaim } from "./scheduler/helpers.ts";

let home: TempHome;
const logs: string[] = [];
const errors: string[] = [];
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  home = useTempHome();
  useTempConfig(home, { workspace: "chessbuddy" });
  logs.length = 0;
  errors.length = 0;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  home.restore();
});

function withDb<T>(fn: (db: ReturnType<typeof openDb>) => T): T {
  mkdirSync(dirname(dbPath()), { recursive: true });
  const db = openDb(dbPath());
  try {
    migrate(db);
    return fn(db);
  } finally {
    db.close();
  }
}

describe("arity", () => {
  test("logs takes 0 or 1 positional; kill and notify test take exactly 1", async () => {
    expect(await dispatch(["logs", "CB-1", "extra"])).toBe(2);
    expect(await dispatch(["kill"])).toBe(2);
    expect(await dispatch(["kill", "CB-1", "CB-2"])).toBe(2);
    expect(await dispatch(["notify"])).toBe(2);
    expect(await dispatch(["notify", "test"])).toBe(2);
    expect(await dispatch(["pause", "x"])).toBe(2);
  });
});

describe("pause / resume", () => {
  test("pause sets the flag once; resume clears it and mentions a live rate-limit pause", async () => {
    expect(await dispatch(["pause"])).toBe(0);
    const at = withDb((db) => manualPauseAt(db));
    expect(at).not.toBeNull();
    expect(logs.at(-1)).toMatch(/paused.*running agents finish/i);
    expect(await dispatch(["pause"])).toBe(0);
    expect(logs.at(-1)).toMatch(/already paused since/);
    expect(withDb((db) => manualPauseAt(db))).toBe(at);

    withDb((db) => setPause(db, new Date(Date.now() + 3_600_000)));
    expect(await dispatch(["resume"])).toBe(0);
    expect(withDb((db) => manualPauseAt(db))).toBeNull();
    expect(logs.at(-1)).toMatch(/resumed \(was paused since .*rate-limit pause is still in effect/);
    expect(await dispatch(["resume"])).toBe(0);
    expect(logs.at(-1)).toMatch(/was not paused/);
  });
});

describe("kill", () => {
  test("unknown or not-running issues exit 1 without touching anything", async () => {
    expect(await dispatch(["kill", "CB-9"])).toBe(1);
    expect(errors.at(-1)).toMatch(/no claim for CB-9/);
    withDb((db) =>
      seedClaim(db, { issueId: "i-1", slot: 0, state: "blocked", identifier: "CB-1" }),
    );
    expect(await dispatch(["kill", "CB-1"])).toBe(1);
    expect(errors.at(-1)).toMatch(/not running \(state: blocked\)/);
  });

  test("with a live orchestrator it writes the kill flag (once) and names the pid", async () => {
    withDb((db) =>
      seedClaim(db, { issueId: "i-1", slot: 0, state: "implementing", identifier: "CB-1" }),
    );
    writePidfile(new Date());
    expect(await dispatch(["kill", "cb-1"])).toBe(0);
    expect(withDb((db) => getFlag(db, killFlag("i-1")))).not.toBeNull();
    expect(logs.at(-1)).toContain(`pid ${process.pid}`);
    expect(await dispatch(["kill", "CB-1"])).toBe(0);
    expect(logs.at(-1)).toMatch(/already requested/);
  });

  test("without an orchestrator it takes the direct path, which needs the Linear key", async () => {
    withDb((db) =>
      seedClaim(db, { issueId: "i-1", slot: 0, state: "implementing", identifier: "CB-1" }),
    );
    const previous = process.env.MARSHALL_LINEAR_API_KEY;
    delete process.env.MARSHALL_LINEAR_API_KEY;
    try {
      await expect(dispatch(["kill", "CB-1"])).rejects.toThrow(/MARSHALL_LINEAR_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.MARSHALL_LINEAR_API_KEY = previous;
    }
    expect(withDb((db) => getFlag(db, killFlag("i-1")))).toBeNull();
  });
});

describe("logs", () => {
  const calls: string[][] = [];
  const exec = async (argv: string[]) => {
    calls.push(argv);
    return 0;
  };

  beforeEach(() => {
    calls.length = 0;
  });

  test("no argument tails marshall.log once it exists", async () => {
    expect(await runLogs({ exec })).toBe(1);
    expect(errors.at(-1)).toMatch(/does not exist yet/);
    mkdirSync(dirname(logPath()), { recursive: true });
    writeFileSync(logPath(), "");
    expect(await runLogs({ exec })).toBe(0);
    expect(calls[0]).toEqual(["tail", "-n", "50", "-f", logPath()]);
  });

  test("an issue resolves to its newest run and hands off to claude logs <jobId>", async () => {
    const wt = join(home.dir, "wt-CB-1");
    withDb((db) => {
      seedClaim(db, {
        issueId: "i-1",
        slot: 0,
        state: "implementing",
        identifier: "CB-1",
        worktreePath: wt,
      });
      insertRun(db, { runId: "old", name: "CB-1 plan", cwd: wt }, "2026-09-21T01:00:00.000Z");
      insertRun(db, { runId: "new", name: "CB-1 implement", cwd: wt }, "2026-09-21T02:00:00.000Z");
      updateRun(db, "new", { jobId: "abcd1234", sessionId: "sess-1", state: "running" });
    });
    expect(await runLogs({ identifier: "CB-1", exec })).toBe(0);
    expect(calls[0]?.slice(1)).toEqual(["logs", "abcd1234"]);
    expect(logs.join("\n")).toContain("new (CB-1 implement, running)");
    expect(logs.join("\n")).toMatch(/transcript .*sess-1\.jsonl/);
    expect(await runLogs({ identifier: "CB-2", exec })).toBe(1);
  });
});

describe("notify test", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.NTFY_TOPIC_PREFIX;
    process.env.NTFY_TOPIC_PREFIX = "t3st";
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.NTFY_TOPIC_PREFIX;
    else process.env.NTFY_TOPIC_PREFIX = previous;
  });

  function fakeFetch(fail = false) {
    const urls: string[] = [];
    const fetchFn: Fetch = async (url) => {
      urls.push(url);
      return new Response("", { status: fail ? 500 : 200 });
    };
    return { fetchFn, urls };
  }

  test("all sends the six sample pushes to the right topics", async () => {
    const f = fakeFetch();
    expect(await runNotifyTest({ event: "all", fetch: f.fetchFn })).toBe(0);
    expect(f.urls).toEqual([
      "https://ntfy.sh/t3st-agent-0",
      "https://ntfy.sh/t3st-agent-0",
      "https://ntfy.sh/t3st-agent-0",
      "https://ntfy.sh/t3st-marshall",
      "https://ntfy.sh/t3st-marshall",
      "https://ntfy.sh/t3st-marshall",
    ]);
    expect(logs).toHaveLength(6);
    expect(logs[0]).toMatch(/^sent\s+t3st-agent-0\s+CB-0 finished$/);
  });

  test("one event, a failure, an unknown event, and a missing prefix", async () => {
    const f = fakeFetch();
    expect(await runNotifyTest({ event: "blocked", fetch: f.fetchFn })).toBe(0);
    expect(f.urls).toEqual(["https://ntfy.sh/t3st-agent-0"]);
    expect(await runNotifyTest({ event: "crashed", fetch: fakeFetch(true).fetchFn })).toBe(1);
    expect(logs.at(-1)).toMatch(/^FAILED/);
    expect(await runNotifyTest({ event: "phase_changed", fetch: f.fetchFn })).toBe(2);
    expect(errors.at(-1)).toMatch(/unknown event phase_changed/);
    delete process.env.NTFY_TOPIC_PREFIX;
    expect(await runNotifyTest({ event: "finished", fetch: f.fetchFn })).toBe(1);
    expect(errors.at(-1)).toMatch(/NTFY_TOPIC_PREFIX/);
  });

  test("sample rows carry the payload each event's push reads", () => {
    expect(sampleRow("blocked", 1).payload).toEqual({ why: "review_exhausted" });
    expect(sampleRow("rate_limited", 2).payload.until).toBeDefined();
    expect(sampleRow("finished", 3)).toMatchObject({ type: "master.finished", slot: 0 });
  });
});
