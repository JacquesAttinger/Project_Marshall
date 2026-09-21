// Last edited: 2026-09-20 23:55 CDT
// The ntfy tailer: the event → topic/priority/link table, the persisted cursor, retry-then-skip on
// a failing POST, and the disabled mode. `fetch` is injected; nothing leaves the process.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate, openDb } from "../src/db/index.ts";
import {
  createNotifier,
  type EventRow,
  type Fetch,
  mapEvent,
  NOTIFY_CURSOR_FLAG,
  type Push,
  readCursor,
} from "../src/notify.ts";
import { getFlag, insertEvent } from "../src/scheduler/store.ts";
import { recordingLogger } from "./helpers.ts";
import { seedClaim } from "./scheduler/helpers.ts";

const OPTS = { prefix: "x7q", workspace: "chessbuddy" };

function row(type: string, overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 1,
    ts: "2026-09-20T20:00:00.000Z",
    type,
    issueId: "issue-12",
    agentId: "agent-1",
    payload: {},
    identifier: "CB-12",
    title: "Fix castling through check",
    slot: 1,
    ...overrides,
  };
}

describe("mapEvent", () => {
  test.each([
    ["master.finished", "x7q-agent-1", "default", true, "CB-12 finished"],
    ["master.blocked", "x7q-agent-1", "high", true, "CB-12 blocked"],
    ["master.over_budget", "x7q-agent-1", "high", true, "CB-12 over budget"],
    ["master.crashed", "x7q-marshall", "high", true, "CB-12 crashed"],
    ["master.rate_limited", "x7q-marshall", "default", false, "CB-12 rate limited"],
    ["master.rate_limit_resumed", "x7q-marshall", "default", false, "CB-12 rate limit resumed"],
  ] as const)("%s → %s, %s, link=%s", (type, topic, priority, link, title) => {
    const push = mapEvent(row(type), OPTS) as Push;
    expect(push).not.toBeNull();
    expect(push.topic).toBe(topic);
    expect(push.priority).toBe(priority);
    expect(push.title).toBe(title);
    expect(push.body.split("\n")[0]).toBe("Fix castling through check");
    if (link) expect(push.click).toBe("https://linear.app/chessbuddy/issue/CB-12");
    else expect(push.click).toBeUndefined();
  });

  test.each([
    "master.phase_changed",
    "master.stalled",
    "master.resumed",
    "master.fresh_restart",
    "master.pr_merged",
    "master.rebased",
    "scheduler.started",
    "hook.Stop",
  ])("%s is badge-only: no push", (type) => {
    expect(mapEvent(row(type), OPTS)).toBeNull();
  });

  test("the block reason and the pause end ride along; the hand-off never does", () => {
    const blocked = mapEvent(
      row("master.blocked", { payload: { why: "review_exhausted", handoffPath: "/x.md" } }),
      OPTS,
    ) as Push;
    expect(blocked.body).toBe("Fix castling through check\nwhy: review_exhausted");
    const limited = mapEvent(
      row("master.rate_limited", { payload: { until: "2026-09-20T21:00:00.000Z" } }),
      OPTS,
    ) as Push;
    expect(limited.body).toBe("Fix castling through check\npaused until 2026-09-20T21:00:00.000Z");
    const finished = mapEvent(
      row("master.finished", { payload: { handoffPath: "/x.md", prUrl: "u" } }),
      OPTS,
    ) as Push;
    expect(finished.body).toBe("Fix castling through check");
  });

  test("a row with no claim falls back to the agent id for the slot and the issue id for the name", () => {
    const push = mapEvent(
      row("master.blocked", { identifier: null, title: null, slot: null, agentId: "agent-0" }),
      OPTS,
    ) as Push;
    expect(push.topic).toBe("x7q-agent-0");
    expect(push.title).toBe("issue-12 blocked");
    expect(push.body).toBe("issue-12");
    expect(push.click).toBeUndefined();
  });

  test("a slot event with no slot at all lands on the orchestrator topic", () => {
    const push = mapEvent(row("master.finished", { slot: null, agentId: null }), OPTS) as Push;
    expect(push.topic).toBe("x7q-marshall");
  });
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(): { fetch: Fetch; sent: Sent[]; failNext: number[] } {
  const sent: Sent[] = [];
  const failNext: number[] = [];
  return {
    sent,
    failNext,
    async fetch(url, init) {
      const status = failNext.shift() ?? 200;
      if (status === 0) throw new Error("network down");
      if (status === 200) {
        sent.push({
          url,
          headers: init.headers as Record<string, string>,
          body: String(init.body),
        });
      }
      return new Response(status === 200 ? "ok" : "nope", { status });
    },
  };
}

let db: Database;
let env: { NTFY_TOPIC_PREFIX?: string };

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  env = { NTFY_TOPIC_PREFIX: "x7q" };
  seedClaim(db, {
    issueId: "issue-12",
    slot: 1,
    state: "implementing",
    identifier: "CB-12",
    title: "Fix castling",
  });
});

afterEach(() => {
  db.close();
});

function emit(type: string, payload: Record<string, unknown> = {}, issueId = "issue-12") {
  insertEvent(db, "2026-09-20T20:00:00.000Z", type, issueId, "agent-1", payload);
}

function make(fetchFn: Fetch) {
  const { log, lines } = recordingLogger();
  const notifier = createNotifier({ db, env, workspace: "chessbuddy", log, fetch: fetchFn });
  return { notifier, lines };
}

describe("createNotifier: cursor", () => {
  test("the first tick only sets the cursor at the newest event: no history blast", async () => {
    emit("master.finished");
    emit("master.blocked");
    const f = fakeFetch();
    const { notifier } = make(f.fetch);
    expect(await notifier.tick()).toBe(0);
    expect(f.sent).toHaveLength(0);
    expect(readCursor(db)).toBe(2);
  });

  test("later events are pushed once each, in order, and the cursor follows", async () => {
    const f = fakeFetch();
    const { notifier } = make(f.fetch);
    await notifier.tick();
    emit("master.phase_changed", { from: "planning", to: "implementing" });
    emit("master.finished", { prUrl: "u" });
    emit("master.rate_limited", { until: "2026-09-20T21:00:00.000Z" });
    expect(await notifier.tick()).toBe(2);
    expect(f.sent.map((s) => s.url)).toEqual([
      "https://ntfy.sh/x7q-agent-1",
      "https://ntfy.sh/x7q-marshall",
    ]);
    expect(f.sent[0]?.headers).toEqual({
      Title: "CB-12 finished",
      Priority: "default",
      Click: "https://linear.app/chessbuddy/issue/CB-12",
    });
    expect(f.sent[0]?.body).toBe("Fix castling");
    expect(readCursor(db)).toBe(3);
    expect(await notifier.tick()).toBe(0);
    expect(f.sent).toHaveLength(2);
  });

  test("a bad cursor value is treated as unset", async () => {
    db.run("INSERT INTO flags (key, value) VALUES (?, ?)", [NOTIFY_CURSOR_FLAG, "junk"]);
    emit("master.finished");
    const f = fakeFetch();
    const { notifier } = make(f.fetch);
    expect(await notifier.tick()).toBe(0);
    expect(getFlag(db, NOTIFY_CURSOR_FLAG)).toBe("1");
  });
});

describe("createNotifier: retries, disabled mode, interval", () => {
  test("a failed POST holds the cursor and is retried; the third failure skips it", async () => {
    const f = fakeFetch();
    const { notifier, lines } = make(f.fetch);
    await notifier.tick();
    emit("master.blocked", { why: "tests_red" });
    emit("master.finished");
    f.failNext.push(500);
    expect(await notifier.tick()).toBe(0);
    expect(readCursor(db)).toBe(0);
    f.failNext.push(0);
    expect(await notifier.tick()).toBe(0);
    expect(readCursor(db)).toBe(0);
    f.failNext.push(503);
    // Third failure: blocked is skipped, finished goes out in the same tick.
    expect(await notifier.tick()).toBe(1);
    expect(readCursor(db)).toBe(2);
    expect(f.sent.map((s) => s.headers.Title)).toEqual(["CB-12 finished"]);
    expect(lines.filter((l) => l.event === "notify.push_failed")).toHaveLength(2);
    expect(lines.filter((l) => l.event === "notify.push_skipped")).toHaveLength(1);
  });

  test("without NTFY_TOPIC_PREFIX the notifier is disabled: one log line, no cursor, no fetch", async () => {
    env = {};
    emit("master.finished");
    const f = fakeFetch();
    const { notifier, lines } = make(f.fetch);
    expect(notifier.enabled).toBe(false);
    expect(await notifier.tick()).toBe(0);
    expect(f.sent).toHaveLength(0);
    expect(readCursor(db)).toBeNull();
    expect(lines.map((l) => l.event)).toEqual(["notify.disabled"]);
    notifier.start(1);
    notifier.stop();
  });

  test("start ticks on the interval and stop ends it", async () => {
    const f = fakeFetch();
    const { notifier } = make(f.fetch);
    await notifier.tick();
    notifier.start(5);
    emit("master.crashed", { why: "boom" });
    const deadline = Date.now() + 1000;
    while (f.sent.length === 0 && Date.now() < deadline) await Bun.sleep(5);
    notifier.stop();
    expect(f.sent.map((s) => s.headers.Title)).toEqual(["CB-12 crashed"]);
    expect(f.sent[0]?.headers.Priority).toBe("high");
    const after = f.sent.length;
    emit("master.finished");
    await Bun.sleep(30);
    expect(f.sent).toHaveLength(after);
  });
});
