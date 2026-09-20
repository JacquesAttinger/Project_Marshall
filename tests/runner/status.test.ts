// Last edited: 2026-09-19 22:55 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { transcriptPath } from "../../src/paths.ts";
import {
  isStalled,
  listDaemonSessions,
  readJobState,
  status,
  transcriptMtime,
} from "../../src/runner/status.ts";
import { insertHookEvent, insertRun, updateRun } from "../../src/runner/store.ts";
import { type RunnerEnv, setFakeAgents, useRunnerEnv } from "./helpers.ts";

let env: RunnerEnv;

beforeEach(() => {
  env = useRunnerEnv();
});

afterEach(() => {
  env.restore();
});

const CWD = "/tmp/marshall-fixture";
const SESSION_1 = "00000000-0000-4000-8000-000000000001";
const MINUTE = 60_000;

/** A roster entry. `pid` (and `status`) appear only while the session process is resident. */
function daemonEntry(id: string, state: string, pid?: number): Record<string, unknown> {
  const base = { id, cwd: CWD, kind: "background", startedAt: 1, sessionId: SESSION_1, name: id };
  return pid === undefined ? { ...base, state } : { ...base, pid, status: "idle", state };
}

/** Write a transcript for `sessionId` and set its mtime to `at`. */
function writeTranscript(sessionId: string, at: Date): string {
  const path = transcriptPath(CWD, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}\n");
  utimesSync(path, at, at);
  return path;
}

describe("readJobState", () => {
  test("parses the stale working shape", () => {
    const s = readJobState("job00001");
    expect(s?.state).toBe("working");
    expect(s?.sessionId).toBe(SESSION_1);
    expect(s?.tokens).toBeNull();
    expect(s?.linkScanPath).toBeNull();
    expect(s?.firstTerminalAt).toBeNull();
    expect(s?.updatedAt).toBe(s?.createdAt as string);
  });

  test("parses the done shape with tokens and linkScanPath", () => {
    const s = readJobState("job00002");
    expect(s?.state).toBe("done");
    expect(s?.tokens).toBe(2103);
    expect(s?.linkScanPath).toContain("transcript-job00002.jsonl");
    expect(s?.output?.result).toBe("hello");
    expect(s?.lastTerminalAt).toBe("2026-09-08T03:32:56.892Z");
  });

  test("parses the done shape without tokens", () => {
    const s = readJobState("job00003");
    expect(s?.state).toBe("done");
    expect(s?.tokens).toBeNull();
    expect(s?.output).toBeNull();
  });

  test("missing job → null", () => {
    expect(readJobState("nope0000")).toBeNull();
  });
});

describe("listDaemonSessions", () => {
  test("keeps only background sessions", async () => {
    setFakeAgents(env, [
      daemonEntry("job00001", "failed"),
      { pid: 1, cwd: CWD, kind: "interactive", sessionId: "x", name: "tty", status: "idle" },
    ]);
    const sessions = await listDaemonSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("job00001");
    expect(sessions[0]?.state).toBe("failed");
    expect(sessions[0]?.pid).toBeNull();
  });

  test("empty roster → []", async () => {
    expect(await listDaemonSessions()).toEqual([]);
  });
});

describe("transcriptMtime", () => {
  test("prefers linkScanPath, falls back to the slug path, null when neither exists", () => {
    expect(transcriptMtime(CWD, SESSION_1)).toBeNull();
    const at = new Date("2026-09-19T20:00:00.000Z");
    writeTranscript(SESSION_1, at);
    expect(transcriptMtime(CWD, SESSION_1)).toBe(at.toISOString());
    expect(transcriptMtime(CWD, SESSION_1, "/nowhere/x.jsonl")).toBe(at.toISOString());
  });
});

describe("status", () => {
  test("stale working state.json + daemon failed → alive false", async () => {
    insertRun(env.db, { runId: "r1", name: "n", cwd: CWD });
    updateRun(env.db, "r1", { jobId: "job00001", state: "running" });
    setFakeAgents(env, [daemonEntry("job00001", "failed")]);
    const s = await status(env.db, "r1");
    expect(s.alive).toBe(false);
    expect(s.daemonState).toBe("failed");
    expect(s.run.sessionId).toBe(SESSION_1);
    expect(s.lastActivityAt).toBeNull();
  });

  test("daemon entry with a pid → alive; tokens and last activity come through", async () => {
    insertRun(env.db, { runId: "r2", name: "n", cwd: CWD });
    updateRun(env.db, "r2", { jobId: "job00002", state: "running" });
    setFakeAgents(env, [daemonEntry("job00002", "working", 4242)]);
    insertHookEvent(env.db, "r2", "SessionStart", "2026-09-19T20:05:00.000Z", {});
    const s = await status(env.db, "r2");
    expect(s.alive).toBe(true);
    expect(s.tokens).toBe(2103);
    expect(s.lastActivityAt).toBe("2026-09-19T20:05:00.000Z");
  });

  test("job missing from the daemon roster → alive false, daemonState null", async () => {
    insertRun(env.db, { runId: "r3", name: "n", cwd: CWD });
    updateRun(env.db, "r3", { jobId: "job00003", state: "running" });
    const s = await status(env.db, "r3");
    expect(s.alive).toBe(false);
    expect(s.daemonState).toBeNull();
  });

  test("a run the runner already marked finished is not alive even with a daemon pid", async () => {
    insertRun(env.db, { runId: "r4", name: "n", cwd: CWD });
    updateRun(env.db, "r4", { jobId: "job00002", state: "finished" });
    setFakeAgents(env, [daemonEntry("job00002", "working", 4242)]);
    expect((await status(env.db, "r4")).alive).toBe(false);
  });

  test("done but still resident (pid present) → alive, so an idle session can stall", async () => {
    insertRun(env.db, { runId: "r5", name: "n", cwd: CWD });
    updateRun(env.db, "r5", { jobId: "job00002", state: "running" });
    setFakeAgents(env, [daemonEntry("job00002", "done", 4242)]);
    const s = await status(env.db, "r5");
    expect(s.alive).toBe(true);
    expect(s.daemonState).toBe("done");
  });
});

describe("isStalled", () => {
  const now = Date.parse("2026-09-19T21:00:00.000Z");

  beforeEach(() => {
    insertRun(env.db, { runId: "r", name: "n", cwd: CWD }, "2026-09-19T20:00:00.000Z");
    updateRun(env.db, "r", { jobId: "job00001", sessionId: SESSION_1, state: "running" });
    setFakeAgents(env, [daemonEntry("job00001", "working", 4242)]);
  });

  test("true when transcript mtime and newest event are both older than the threshold", async () => {
    writeTranscript(SESSION_1, new Date(now - 10 * MINUTE));
    insertHookEvent(env.db, "r", "SessionStart", new Date(now - 12 * MINUTE).toISOString(), {});
    expect(await isStalled(env.db, "r", 5, now)).toBe(true);
  });

  test("false when the transcript is fresh", async () => {
    writeTranscript(SESSION_1, new Date(now - 1 * MINUTE));
    insertHookEvent(env.db, "r", "SessionStart", new Date(now - 12 * MINUTE).toISOString(), {});
    expect(await isStalled(env.db, "r", 5, now)).toBe(false);
  });

  test("false when the newest event is fresh", async () => {
    writeTranscript(SESSION_1, new Date(now - 10 * MINUTE));
    insertHookEvent(env.db, "r", "Notification", new Date(now - 1 * MINUTE).toISOString(), {});
    expect(await isStalled(env.db, "r", 5, now)).toBe(false);
  });

  test("false when not alive (no pid: the session was stopped)", async () => {
    setFakeAgents(env, [daemonEntry("job00001", "done")]);
    writeTranscript(SESSION_1, new Date(now - 10 * MINUTE));
    expect(await isStalled(env.db, "r", 5, now)).toBe(false);
  });

  test("no activity at all counts from createdAt", async () => {
    expect(await isStalled(env.db, "r", 5, now)).toBe(true);
    expect(await isStalled(env.db, "r", 90, now)).toBe(false);
  });
});
