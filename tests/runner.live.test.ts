// Last edited: 2026-09-19 23:20 CDT
// Live smoke test against the real Claude daemon. Skipped unless MARSHALL_LIVE=1.
// Run: MARSHALL_LIVE=1 bun test tests/runner.live.test.ts
// Uses ~/.claude (not a fixture), a temp MARSHALL_HOME, and a temp git repo as the agent's cwd.
// Every job it starts is stopped and removed from the daemon roster at the end.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../src/db/index.ts";
import { ensureHome } from "../src/paths.ts";
import { runClaude } from "../src/runner/claude.ts";
import {
  type DaemonSession,
  type HookEvent,
  isStalled,
  kill,
  launch,
  listDaemonSessions,
  type Run,
  readJobState,
  resume,
  startWatcher,
  status,
  type Terminal,
  type Watcher,
} from "../src/runner/index.ts";
import { type TempHome, useTempHome } from "./helpers.ts";

const LIVE = process.env.MARSHALL_LIVE === "1";
/** Each criterion is its own top-level test so no callback grows past the 75-line limit. */
const live = test.skipIf(!LIVE);
const MODEL = process.env.MARSHALL_LIVE_MODEL ?? "haiku";
const TURN_TIMEOUT_MS = 120_000;

interface Seen {
  run: Run;
  event: HookEvent;
  terminal: Terminal;
}

let home: TempHome;
let repo: string;
let db: ReturnType<typeof openDb>;
let watcher: Watcher;
const seen: Seen[] = [];
const jobIds: string[] = [];
const report: Record<string, unknown> = {};

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  ms: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe();
    if (v !== undefined) return v;
    await Bun.sleep(500);
  }
  throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
}

async function daemonEntry(jobId: string): Promise<DaemonSession | undefined> {
  return (await listDaemonSessions()).find((s) => s.id === jobId);
}

/** The roster entry once it has a pid (resident) or once the pid is gone (stopped). */
function waitForDaemon(jobId: string, resident: boolean): Promise<DaemonSession> {
  return waitFor(
    async () => {
      const e = await daemonEntry(jobId);
      return e && (e.pid !== null) === resident ? e : undefined;
    },
    30_000,
    `job ${jobId} ${resident ? "resident" : "stopped"}`,
  );
}

function terminalFor(runId: string): Promise<Seen> {
  return waitFor(
    () => seen.find((s) => s.run.runId === runId),
    TURN_TIMEOUT_MS,
    `terminal event for ${runId}`,
  );
}

function hookCount(runId: string, name: string): number {
  return (
    db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND type = ?",
      )
      .get(runId, `hook.${name}`)?.n ?? 0
  );
}

beforeAll(() => {
  if (!LIVE) return;
  home = useTempHome("marshall-live-");
  ensureHome();
  repo = mkdtempSync(join(tmpdir(), "marshall-live-repo-"));
  writeFileSync(join(repo, "README.md"), "# live test repo\n");
  db = openDb(":memory:");
  migrate(db);
  watcher = startWatcher(db, (run, event, terminal) => seen.push({ run, event, terminal }));
});

afterAll(async () => {
  if (!LIVE) return;
  watcher.stop();
  for (const id of jobIds) {
    await runClaude(["stop", id]).catch(() => undefined);
    await runClaude(["rm", id]).catch((err: Error) =>
      console.warn(`claude rm ${id} failed: ${err.message}`),
    );
  }
  db.close();
  if (process.env.MARSHALL_LIVE_REPORT) {
    writeFileSync(process.env.MARSHALL_LIVE_REPORT, JSON.stringify(report, null, 2));
  }
  rmSync(repo, { recursive: true, force: true });
  home.restore();
});

let first: Run;

live(
  "1. launch → Stop hook → finished → daemon shows the job stopped",
  async () => {
    first = await launch(db, {
      name: "marshall-live-1",
      cwd: repo,
      prompt: "Print hello, then stop.",
      model: MODEL,
      effort: "low",
    });
    const jobId = first.jobId as string;
    jobIds.push(jobId);
    report.launched = {
      run: first,
      state: readJobState(jobId),
      daemon: await daemonEntry(jobId),
    };

    const done = await terminalFor(first.runId);
    expect(done.terminal).toEqual({ kind: "finished" });
    expect(done.event.name).toBe("Stop");
    expect(String(done.event.payload.last_assistant_message).toLowerCase()).toContain("hello");
    expect(done.run.state).toBe("finished");
    expect(done.run.sessionId).not.toBeNull();
    first = done.run;

    // The runner ran `claude stop`; the daemon drops `pid` once the process is gone.
    const stopped = await waitForDaemon(jobId, false);
    const s = await status(db, first.runId);
    expect(s.alive).toBe(false);
    await waitFor(() => hookCount(first.runId, "SessionEnd") || undefined, 30_000, "SessionEnd");
    report.finished = { run: s.run, state: readJobState(jobId), daemon: stopped };
  },
  TURN_TIMEOUT_MS + 60_000,
);

live(
  "2. kill mid-turn → not alive, process gone, SessionEnd arrives",
  async () => {
    const run = await launch(db, {
      name: "marshall-live-2",
      cwd: repo,
      prompt:
        "Count from 1 to 1000. Print each number with Bash, running `sleep 1` between numbers.",
      model: MODEL,
      effort: "low",
    });
    const jobId = run.jobId as string;
    jobIds.push(jobId);
    const live = await waitForDaemon(jobId, true);
    await Bun.sleep(10_000);
    report.working = { run, state: readJobState(jobId), daemon: await daemonEntry(jobId) };

    const killed = await kill(db, run.runId);
    expect(killed.state).toBe("killed");
    await waitFor(
      () => {
        try {
          process.kill(live.pid as number, 0);
          return undefined;
        } catch {
          return true;
        }
      },
      30_000,
      `pid ${live.pid} to exit`,
    );
    const s = await status(db, run.runId);
    expect(s.alive).toBe(false);
    await waitFor(() => hookCount(run.runId, "SessionEnd") || undefined, 30_000, "SessionEnd");
    report.killed = { run: s.run, state: readJobState(jobId), daemon: await daemonEntry(jobId) };
  },
  120_000,
);

live(
  "3. resume the first session → the agent remembers hello",
  async () => {
    const run = await resume(db, {
      name: "marshall-live-3",
      cwd: repo,
      prompt: "What single word did you print earlier in this session? Reply with just that word.",
      sessionId: first.sessionId as string,
      model: MODEL,
      effort: "low",
    });
    const jobId = run.jobId as string;
    jobIds.push(jobId);
    expect(run.resumedFrom).toBe(first.sessionId);
    const done = await terminalFor(run.runId);
    expect(done.terminal.kind).toBe("finished");
    expect(String(done.event.payload.last_assistant_message).toLowerCase()).toContain("hello");
    // The daemon forks a stopped session into a new session id and job id.
    expect(done.run.sessionId).not.toBeNull();
    expect(done.run.sessionId).not.toBe(first.sessionId);
    expect(run.jobId).not.toBe(first.jobId);
    report.resumed = {
      run: done.run,
      state: readJobState(jobId),
      daemon: await daemonEntry(jobId),
    };
  },
  TURN_TIMEOUT_MS + 60_000,
);

live(
  "4. isStalled is true for a live job with no activity inside the window",
  async () => {
    const run = await launch(db, {
      name: "marshall-live-4",
      cwd: repo,
      prompt: "Run `sleep 45` with Bash, then print done.",
      model: MODEL,
      effort: "low",
    });
    const jobId = run.jobId as string;
    jobIds.push(jobId);
    await waitForDaemon(jobId, true);
    await Bun.sleep(3_000);
    expect(await isStalled(db, run.runId, 5)).toBe(false);
    // Pretend 10 minutes have passed: transcript mtime and the newest hook row are both older.
    const later = Date.now() + 10 * 60_000;
    expect(await isStalled(db, run.runId, 5, later)).toBe(true);
    await kill(db, run.runId);
    await waitForDaemon(jobId, false);
    expect(await isStalled(db, run.runId, 5, later)).toBe(false);
  },
  90_000,
);
