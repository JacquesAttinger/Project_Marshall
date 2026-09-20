// Last edited: 2026-09-20 12:35 CDT
// Hook events: ingest a run's events file into the `events` table, classify terminal events,
// and watch the events folder so the runner learns about completion without polling the daemon.
// On a terminal event the runner stops the (now idle) session so resume never creates a copy.

import type { Database } from "bun:sqlite";
import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { createLogger } from "../log.ts";
import { eventsDir } from "../paths.ts";
import { runClaude } from "./claude.ts";
import { eventsFile } from "./settings.ts";
import { getRun, insertHookEvent, isTerminal, listActiveRuns, updateRun } from "./store.ts";
import type { HookEvent, Run, Terminal } from "./types.ts";

const log = createLogger({ module: "runner" });

/** Parse one line written by hook-sink.sh. Malformed lines return null and are skipped. */
export function parseEventLine(line: string, runId: string): HookEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const {
    received_at: receivedAt,
    event,
    stop_blocked: stopBlocked,
  } = parsed as { received_at?: unknown; event?: unknown; stop_blocked?: unknown };
  if (typeof receivedAt !== "string" || !event || typeof event !== "object") return null;
  const payload = event as Record<string, unknown>;
  const name = payload.hook_event_name;
  if (typeof name !== "string") return null;
  return {
    receivedAt,
    runId,
    name,
    payload,
    ...(stopBlocked === true ? { stopBlocked: true } : {}),
  };
}

/**
 * Ingest every complete line past `runs.events_offset`. A partial trailing line (no newline yet)
 * is left for the next pass. Rows and the new offset land in one transaction.
 */
export function ingestFile(db: Database, runId: string): HookEvent[] {
  const run = getRun(db, runId);
  const path = eventsFile(runId);
  if (!run || !existsSync(path)) return [];
  // Offsets are bytes, so slice the buffer before decoding: a multibyte char must never be split.
  const bytes = readFileSync(path);
  if (bytes.length <= run.eventsOffset) return [];
  const chunk = bytes.subarray(run.eventsOffset);
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) return [];
  const complete = chunk.subarray(0, lastNewline).toString("utf8");
  const events: HookEvent[] = [];
  for (const line of complete.split("\n")) {
    if (line.trim().length === 0) continue;
    const ev = parseEventLine(line, runId);
    if (ev) events.push(ev);
    else log.warn("run.event_unparseable", { runId, line: line.slice(0, 200) });
  }
  db.transaction(() => {
    for (const ev of events) insertHookEvent(db, runId, ev.name, ev.receivedAt, ev.payload);
    const sessionId = events.map((e) => e.payload.session_id).find((s) => typeof s === "string");
    updateRun(db, runId, {
      eventsOffset: run.eventsOffset + lastNewline + 1,
      ...(run.sessionId === null && typeof sessionId === "string" ? { sessionId } : {}),
      ...(run.state === "starting" && events.length > 0 ? { state: "running" } : {}),
    });
  })();
  return events;
}

/**
 * `Stop` with nothing left in the background → finished, unless the Stop guard blocked it (the
 * agent was sent back to work). `StopFailure` → failed. Else null.
 */
export function classify(event: HookEvent): Terminal | null {
  if (event.name === "Stop") {
    if (event.stopBlocked) return null;
    const tasks = event.payload.background_tasks;
    return Array.isArray(tasks) && tasks.length > 0 ? null : { kind: "finished" };
  }
  if (event.name === "StopFailure")
    return { kind: "failed", error: failureKind(event) ?? "unknown" };
  return null;
}

/** The `error` field of a StopFailure (`rate_limit`, `overloaded`, ...), or null for other events. */
export function failureKind(event: HookEvent): string | null {
  if (event.name !== "StopFailure") return null;
  const error = event.payload.error;
  return typeof error === "string" ? error : "unknown";
}

export function rateLimited(event: HookEvent): boolean {
  return failureKind(event) === "rate_limit";
}

/** `claude stop <jobId>`. Errors are logged, not thrown: the daemon may already have stopped it. */
export async function stopJob(jobId: string): Promise<boolean> {
  try {
    await runClaude(["stop", jobId]);
    return true;
  } catch (err) {
    log.warn("run.stop_failed", { jobId, error: (err as Error).message });
    return false;
  }
}

export type TerminalHandler = (run: Run, event: HookEvent, terminal: Terminal) => void;

/** Ingest one run's new events; on the first terminal one, stop the job and mark the run. */
export async function processRun(db: Database, runId: string, onTerminal?: TerminalHandler) {
  for (const event of ingestFile(db, runId)) {
    const terminal = classify(event);
    if (!terminal) continue;
    const run = getRun(db, runId);
    if (!run || isTerminal(run.state)) continue;
    if (run.jobId) await stopJob(run.jobId);
    const updated = updateRun(db, runId, {
      state: terminal.kind,
      error: terminal.kind === "failed" ? terminal.error : null,
      finishedAt: event.receivedAt,
    });
    log.info(`run.${terminal.kind}`, { runId, jobId: run.jobId, error: updated.error });
    onTerminal?.(updated, event, terminal);
  }
}

export interface Watcher {
  /** Ingest every active run now. The watcher calls this itself on change and on the poll. */
  scan(): Promise<void>;
  stop(): void;
}

export interface WatcherOpts {
  /** Fallback poll interval; fs.watch does the real work. 0 disables. */
  pollMs?: number;
}

/**
 * Catch up on every active run, then watch the events folder. Each change ingests the run whose
 * file changed. Returns a handle whose `stop()` releases the watcher and the poll timer.
 */
export function startWatcher(db: Database, onTerminal?: TerminalHandler, opts: WatcherOpts = {}) {
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (runIds: string[]): Promise<void> => {
    chain = chain.then(async () => {
      for (const id of runIds) await processRun(db, id, onTerminal);
    });
    return chain;
  };
  const scan = () => enqueue(listActiveRuns(db).map((r) => r.runId));
  const dir = eventsDir();
  let fsWatcher: FSWatcher | null = null;
  try {
    fsWatcher = watch(dir, (_event, filename) => {
      const name = String(filename ?? "");
      if (name.endsWith(".jsonl")) void enqueue([name.slice(0, -".jsonl".length)]);
    });
  } catch (err) {
    log.warn("run.watch_failed", { dir, error: (err as Error).message });
  }
  const pollMs = opts.pollMs ?? 2000;
  const timer = pollMs > 0 ? setInterval(() => void scan(), pollMs) : null;
  void scan();
  const watcher: Watcher = {
    scan,
    stop() {
      fsWatcher?.close();
      if (timer) clearInterval(timer);
    },
  };
  return watcher;
}
