// Last edited: 2026-09-19 23:20 CDT
// Row helpers for the `runs` table and hook rows in `events`. All SQL for the runner lives here.

import type { Database } from "bun:sqlite";
import type { Run, RunState } from "./types.ts";

interface RunRow {
  run_id: string;
  job_id: string | null;
  session_id: string | null;
  name: string;
  cwd: string;
  state: string;
  error: string | null;
  resumed_from: string | null;
  events_offset: number;
  created_at: string;
  finished_at: string | null;
}

function rowToRun(r: RunRow): Run {
  return {
    runId: r.run_id,
    jobId: r.job_id,
    sessionId: r.session_id,
    name: r.name,
    cwd: r.cwd,
    state: r.state as RunState,
    error: r.error,
    resumedFrom: r.resumed_from,
    eventsOffset: r.events_offset,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

const TERMINAL: RunState[] = ["finished", "failed", "killed"];

export function isTerminal(state: RunState): boolean {
  return TERMINAL.includes(state);
}

export interface NewRun {
  runId: string;
  name: string;
  cwd: string;
  resumedFrom?: string | null;
}

export function insertRun(db: Database, run: NewRun, now = new Date().toISOString()): Run {
  db.run(
    `INSERT INTO runs (run_id, name, cwd, state, resumed_from, created_at)
     VALUES (?, ?, ?, 'starting', ?, ?)`,
    [run.runId, run.name, run.cwd, run.resumedFrom ?? null, now],
  );
  return getRun(db, run.runId) as Run;
}

export function getRun(db: Database, runId: string): Run | null {
  const row = db.query<RunRow, [string]>("SELECT * FROM runs WHERE run_id = ?").get(runId);
  return row ? rowToRun(row) : null;
}

export function getRunByJob(db: Database, jobId: string): Run | null {
  const row = db
    .query<RunRow, [string]>("SELECT * FROM runs WHERE job_id = ? ORDER BY created_at DESC")
    .get(jobId);
  return row ? rowToRun(row) : null;
}

/** Runs that may still produce events: anything not finished, failed, or killed. */
export function listActiveRuns(db: Database): Run[] {
  return db
    .query<RunRow, []>(
      "SELECT * FROM runs WHERE state NOT IN ('finished', 'failed', 'killed') ORDER BY created_at",
    )
    .all()
    .map(rowToRun);
}

export interface RunPatch {
  jobId?: string;
  sessionId?: string;
  state?: RunState;
  error?: string | null;
  eventsOffset?: number;
  finishedAt?: string | null;
}

const COLUMNS: Record<keyof RunPatch, string> = {
  jobId: "job_id",
  sessionId: "session_id",
  state: "state",
  error: "error",
  eventsOffset: "events_offset",
  finishedAt: "finished_at",
};

export function updateRun(db: Database, runId: string, patch: RunPatch): Run {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${COLUMNS[key as keyof RunPatch]} = ?`);
    values.push(value as string | number | null);
  }
  if (sets.length > 0) {
    values.push(runId);
    db.run(`UPDATE runs SET ${sets.join(", ")} WHERE run_id = ?`, values);
  }
  return getRun(db, runId) as Run;
}

/** Hook events are audit rows: `type = hook.<name>`, `agent_id = runId`, `ts = received_at`. */
export function insertHookEvent(
  db: Database,
  runId: string,
  name: string,
  receivedAt: string,
  payload: Record<string, unknown>,
): void {
  db.run("INSERT INTO events (ts, agent_id, type, payload) VALUES (?, ?, ?, ?)", [
    receivedAt,
    runId,
    `hook.${name}`,
    JSON.stringify(payload),
  ]);
}

/** ISO timestamp of the newest hook row for a run, or null. */
export function newestHookEventAt(db: Database, runId: string): string | null {
  const row = db
    .query<{ ts: string | null }, [string]>(
      "SELECT MAX(ts) AS ts FROM events WHERE agent_id = ? AND type LIKE 'hook.%'",
    )
    .get(runId);
  return row?.ts ?? null;
}

export function countHookEvents(db: Database, runId: string): number {
  const row = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND type LIKE 'hook.%'",
    )
    .get(runId);
  return row?.n ?? 0;
}
