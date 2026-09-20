// Last edited: 2026-09-19 22:20 CDT
// Three sources of truth, joined: `claude agents --json` (alive?), the transcript's mtime and the
// newest hook event (still working?), and the daemon's state.json (ids, timestamps, tokens).

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeJobsDir, transcriptPath } from "../paths.ts";
import { runClaude } from "./claude.ts";
import { getRun, isTerminal, newestHookEventAt } from "./store.ts";
import { RunnerError, type RunStatus } from "./types.ts";

/** The subset of `~/.claude/jobs/<id>/state.json` that Marshall reads. */
export interface JobState {
  state: string;
  sessionId: string | null;
  name: string | null;
  cwd: string | null;
  tokens: number | null;
  /** The transcript path the daemon scans, when it has recorded one. */
  linkScanPath: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  firstTerminalAt: string | null;
  lastTerminalAt: string | null;
  output: { result?: string } | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Parse a job's state.json. Missing file → null. Unreadable JSON → RunnerError. */
export function readJobState(jobId: string): JobState | null {
  const path = join(claudeJobsDir(), jobId, "state.json");
  if (!existsSync(path)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new RunnerError(`Unreadable ${path}: ${(err as Error).message}`);
  }
  return {
    state: str(raw.state) ?? "unknown",
    sessionId: str(raw.sessionId) ?? str(raw.resumeSessionId),
    name: str(raw.name),
    cwd: str(raw.cwd),
    tokens: typeof raw.tokens === "number" ? raw.tokens : null,
    linkScanPath: str(raw.linkScanPath),
    createdAt: str(raw.createdAt),
    updatedAt: str(raw.updatedAt),
    firstTerminalAt: str(raw.firstTerminalAt),
    lastTerminalAt: str(raw.lastTerminalAt),
    output:
      raw.output && typeof raw.output === "object" ? (raw.output as JobState["output"]) : null,
  };
}

/** One entry of `claude agents --json --all`, background kind only. */
export interface DaemonSession {
  id: string;
  cwd: string;
  sessionId: string | null;
  name: string | null;
  state: string;
  startedAt: number | null;
}

/** Daemon states that mean the job is no longer running. Anything else counts as alive. */
export const DAEMON_TERMINAL_STATES = new Set(["done", "failed", "stopped", "killed", "exited"]);

export async function listDaemonSessions(): Promise<DaemonSession[]> {
  const out = await runClaude(["agents", "--json", "--all"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new RunnerError(`claude agents --json printed non-JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new RunnerError("claude agents --json did not print an array");
  return parsed
    .filter((e) => e && typeof e === "object" && (e as { kind?: string }).kind === "background")
    .map((e) => {
      const r = e as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        cwd: str(r.cwd) ?? "",
        sessionId: str(r.sessionId),
        name: str(r.name),
        state: str(r.state) ?? "unknown",
        startedAt: typeof r.startedAt === "number" ? r.startedAt : null,
      };
    });
}

/** Mtime of the session transcript as ISO, or null when no transcript exists yet. */
export function transcriptMtime(
  cwd: string,
  sessionId: string | null,
  linkScanPath?: string | null,
): string | null {
  const candidates = [linkScanPath, sessionId ? transcriptPath(cwd, sessionId) : null];
  for (const path of candidates) {
    if (path && existsSync(path)) return statSync(path).mtime.toISOString();
  }
  return null;
}

function newest(...times: (string | null)[]): string | null {
  let best: string | null = null;
  for (const t of times) {
    if (t && (best === null || Date.parse(t) > Date.parse(best))) best = t;
  }
  return best;
}

/** Join the three sources for one run. */
export async function status(db: Database, runId: string): Promise<RunStatus> {
  const run = getRun(db, runId);
  if (!run) throw new RunnerError(`Unknown run ${runId}`);
  const job = run.jobId ? readJobState(run.jobId) : null;
  const daemon = run.jobId
    ? (await listDaemonSessions()).find((s) => s.id === run.jobId)
    : undefined;
  const sessionId = run.sessionId ?? job?.sessionId ?? daemon?.sessionId ?? null;
  const alive =
    !isTerminal(run.state) && daemon !== undefined && !DAEMON_TERMINAL_STATES.has(daemon.state);
  return {
    run: { ...run, sessionId },
    alive,
    daemonState: daemon?.state ?? null,
    lastActivityAt: newest(
      transcriptMtime(run.cwd, sessionId, job?.linkScanPath),
      newestHookEventAt(db, runId),
    ),
    tokens: job?.tokens ?? null,
  };
}

/** Alive and no sign of progress for `minutes`. A run with no activity yet counts from createdAt. */
export async function isStalled(
  db: Database,
  runId: string,
  minutes: number,
  now: number = Date.now(),
): Promise<boolean> {
  const s = await status(db, runId);
  if (!s.alive) return false;
  const last = Date.parse(s.lastActivityAt ?? s.run.createdAt);
  return now - last > minutes * 60_000;
}
