// Last edited: 2026-09-20 23:05 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import {
  classify,
  failureKind,
  ingestFile,
  parseEventLine,
  processRun,
  rateLimited,
  startWatcher,
} from "../../src/runner/events.ts";
import { eventsFile } from "../../src/runner/settings.ts";
import { countHookEvents, getRun, insertRun, updateRun } from "../../src/runner/store.ts";
import type { HookEvent } from "../../src/runner/types.ts";
import { fakeStops, hookFixture, type RunnerEnv, useRunnerEnv } from "./helpers.ts";

let env: RunnerEnv;

beforeEach(() => {
  env = useRunnerEnv();
});

afterEach(() => {
  env.restore();
});

const CWD = "/tmp/marshall-fixture";
const SESSION_1 = "00000000-0000-4000-8000-000000000001";

function line(fixture: string, receivedAt = "2026-09-19T21:00:00Z"): string {
  return `${JSON.stringify({ received_at: receivedAt, event: hookFixture(fixture) })}\n`;
}

function event(fixture: string): HookEvent {
  return parseEventLine(line(fixture).trim(), "r") as HookEvent;
}

function newRun(runId: string, jobId = "job00001"): void {
  insertRun(env.db, { runId, name: "n", cwd: CWD });
  updateRun(env.db, runId, { jobId });
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
}

describe("ingestFile", () => {
  test("three lines → three events rows, offset advances, session id and running state set", () => {
    newRun("r");
    const path = eventsFile("r");
    writeFileSync(path, line("session-start") + line("stop-busy") + line("session-end"));
    const events = ingestFile(env.db, "r");
    expect(events.map((e) => e.name)).toEqual(["SessionStart", "Stop", "SessionEnd"]);
    expect(countHookEvents(env.db, "r")).toBe(3);
    const run = getRun(env.db, "r");
    expect(run?.eventsOffset).toBe(Bun.file(path).size);
    expect(run?.sessionId).toBe(SESSION_1);
    expect(run?.state).toBe("running");
    expect(ingestFile(env.db, "r")).toEqual([]);
  });

  test("a partial trailing line waits for its newline", () => {
    newRun("r");
    const path = eventsFile("r");
    const full = line("session-start");
    writeFileSync(path, full + line("stop-empty").slice(0, 40));
    expect(ingestFile(env.db, "r")).toHaveLength(1);
    expect(getRun(env.db, "r")?.eventsOffset).toBe(Buffer.byteLength(full));
    appendFileSync(path, line("stop-empty").slice(40));
    expect(ingestFile(env.db, "r").map((e) => e.name)).toEqual(["Stop"]);
    expect(getRun(env.db, "r")?.eventsOffset).toBe(Bun.file(path).size);
  });

  test("multibyte text before the split point does not corrupt the offset", () => {
    newRun("r");
    const path = eventsFile("r");
    const payload = { ...hookFixture("stop-empty"), last_assistant_message: "héllo — ✓" };
    const first = `${JSON.stringify({ received_at: "2026-09-19T21:00:00Z", event: payload })}\n`;
    writeFileSync(path, first);
    expect(ingestFile(env.db, "r")[0]?.payload.last_assistant_message).toBe("héllo — ✓");
    appendFileSync(path, line("session-end"));
    expect(ingestFile(env.db, "r").map((e) => e.name)).toEqual(["SessionEnd"]);
  });

  test("missing file or unknown run → []", () => {
    newRun("r");
    expect(ingestFile(env.db, "r")).toEqual([]);
    expect(ingestFile(env.db, "nope")).toEqual([]);
  });

  test("stop_blocked on a line lands on the event", () => {
    newRun("r");
    const blocked = {
      received_at: "2026-09-19T21:00:00Z",
      event: hookFixture("stop-empty"),
      stop_blocked: true,
    };
    writeFileSync(eventsFile("r"), `${JSON.stringify(blocked)}\n${line("stop-empty")}`);
    const events = ingestFile(env.db, "r");
    expect(events.map((e) => e.stopBlocked)).toEqual([true, undefined]);
  });

  test("a malformed line is skipped, the rest ingest", () => {
    newRun("r");
    writeFileSync(eventsFile("r"), `not json\n${line("stop-empty")}`);
    expect(ingestFile(env.db, "r").map((e) => e.name)).toEqual(["Stop"]);
  });
});

describe("classify", () => {
  test("Stop with empty background_tasks → finished", () => {
    expect(classify(event("stop-empty"))).toEqual({ kind: "finished" });
  });

  test("Stop with background tasks is not terminal", () => {
    expect(classify(event("stop-busy"))).toBeNull();
  });

  test("a Stop the guard blocked is not terminal", () => {
    expect(classify({ ...event("stop-empty"), stopBlocked: true })).toBeNull();
  });

  test("StopFailure → failed with the error kind and its details", () => {
    expect(classify(event("stop-failure-rate-limit"))).toEqual({
      kind: "failed",
      error: "rate_limit",
      details: "You've hit your usage limit. Resets at 3pm.",
    });
    const bare = event("stop-failure-rate-limit");
    delete bare.payload.error_details;
    expect(classify(bare)).toEqual({ kind: "failed", error: "rate_limit" });
  });

  test("SessionStart and SessionEnd are informational", () => {
    expect(classify(event("session-start"))).toBeNull();
    expect(classify(event("session-end"))).toBeNull();
  });
});

describe("rateLimited / failureKind", () => {
  test("rate_limit → true, overloaded → false, Stop → false", () => {
    expect(rateLimited(event("stop-failure-rate-limit"))).toBe(true);
    expect(rateLimited(event("stop-failure-overloaded"))).toBe(false);
    expect(rateLimited(event("stop-empty"))).toBe(false);
    expect(failureKind(event("stop-failure-overloaded"))).toBe("overloaded");
    expect(failureKind(event("stop-empty"))).toBeNull();
  });
});

describe("processRun", () => {
  test("a terminal event stops the job once and marks the run", async () => {
    newRun("r", "job00002");
    const seen: string[] = [];
    writeFileSync(
      eventsFile("r"),
      line("session-start") + line("stop-empty", "2026-09-19T21:05:00Z"),
    );
    await processRun(env.db, "r", (run, ev, t) => seen.push(`${run.state}:${ev.name}:${t.kind}`));
    expect(seen).toEqual(["finished:Stop:finished"]);
    expect(fakeStops(env)).toEqual(["job00002"]);
    const run = getRun(env.db, "r");
    expect(run?.state).toBe("finished");
    expect(run?.finishedAt).toBe("2026-09-19T21:05:00Z");
    expect(run?.error).toBeNull();
    // A later SessionEnd (from the stop) does not re-trigger.
    appendFileSync(eventsFile("r"), line("session-end"));
    await processRun(env.db, "r", () => seen.push("again"));
    expect(seen).toHaveLength(1);
    expect(fakeStops(env)).toHaveLength(1);
  });

  test("StopFailure marks failed with the error", async () => {
    newRun("r");
    writeFileSync(eventsFile("r"), line("stop-failure-rate-limit"));
    await processRun(env.db, "r");
    const run = getRun(env.db, "r");
    expect(run?.state).toBe("failed");
    expect(run?.error).toBe("rate_limit");
  });
});

describe("startWatcher", () => {
  test("catches up on a pre-existing file, then picks up appends", async () => {
    newRun("r");
    writeFileSync(eventsFile("r"), line("session-start"));
    const seen: string[] = [];
    const watcher = startWatcher(env.db, (_run, ev) => seen.push(ev.name), { pollMs: 0 });
    try {
      await until(() => countHookEvents(env.db, "r") === 1);
      appendFileSync(eventsFile("r"), line("stop-empty"));
      await until(() => seen.length === 1);
      expect(seen).toEqual(["Stop"]);
      expect(fakeStops(env)).toEqual(["job00001"]);
    } finally {
      watcher.stop();
    }
  });

  test("a file for a run the DB does not know is ignored", async () => {
    const watcher = startWatcher(env.db, undefined, { pollMs: 0 });
    try {
      writeFileSync(eventsFile("ghost"), line("stop-empty"));
      await Bun.sleep(150);
      expect(fakeStops(env)).toEqual([]);
    } finally {
      watcher.stop();
    }
  });
});
