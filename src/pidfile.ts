// Last edited: 2026-09-21 00:55 CDT
// The orchestrator's pidfile. `marshall run` writes it and removes it on a clean exit; `kill` and
// `status` read it to learn whether a live orchestrator will act on a flag, whether launchd or a
// terminal started it. A stale file (crash, power loss) reads as "not running" once its pid is gone.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { pidPath } from "./paths.ts";

export interface OrchestratorProcess {
  pid: number;
  startedAt: string;
}

export function writePidfile(now: Date, pid: number = process.pid, path = pidPath()): void {
  writeFileSync(path, JSON.stringify({ pid, startedAt: now.toISOString() }));
}

export function removePidfile(path = pidPath()): void {
  if (existsSync(path)) unlinkSync(path);
}

/** True when a process with this pid exists (signal 0 is a probe, not a kill). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else. Still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What the pidfile says, whether or not that process still exists. */
export function readPidfile(path = pidPath()): OrchestratorProcess | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<OrchestratorProcess>;
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    return { pid: raw.pid, startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "" };
  } catch {
    return null;
  }
}

/** The live orchestrator, or null when none is running (no file, or a stale one). */
export function liveOrchestrator(path = pidPath()): OrchestratorProcess | null {
  const found = readPidfile(path);
  return found && processAlive(found.pid) ? found : null;
}
