// Last edited: 2026-09-20 12:30 CDT
// Stop-hook guard for runs that report through a status file (implement.json).
// Usage: bun scripts/stop-guard.ts <statusFile>   (stdin: the Stop hook payload)
//
// Prints {"decision":"block","reason":...} when the agent is about to stop with no outcome
// written and nothing running in the background, so Claude Code sends it back to work.
// Prints nothing (allow) otherwise. Exit code is always 0: a broken guard must never end a run.
// Blocks are capped per status file so a wedged agent cannot be bounced forever.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_STOP_BLOCKS = 3;

export interface GuardVerdict {
  decision: "block";
  reason: string;
}

interface StopPayload {
  hook_event_name?: unknown;
  background_tasks?: unknown;
}

function readCount(path: string): number {
  try {
    return Number.parseInt(readFileSync(path, "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}

/** The sidecar that counts blocks: `<statusFile>.stop-blocks`. */
export function blocksPath(statusFile: string): string {
  return `${statusFile}.stop-blocks`;
}

/** What the status file says: `{ outcome, phase }`, or null when absent or unreadable. */
function readStatus(statusFile: string): { outcome: unknown; phase: unknown } | null {
  if (!existsSync(statusFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statusFile, "utf8")) as Record<string, unknown>;
    return { outcome: parsed.outcome ?? null, phase: parsed.phase ?? null };
  } catch {
    return null;
  }
}

/**
 * Decide, without side effects, whether this Stop must be blocked.
 * `blocksSoFar` is the number of times this status file has already blocked a stop.
 */
export function decide(
  payload: StopPayload,
  status: { outcome: unknown; phase: unknown } | null,
  statusFile: string,
  blocksSoFar: number,
): GuardVerdict | null {
  if (payload.hook_event_name !== "Stop") return null;
  const tasks = payload.background_tasks;
  if (Array.isArray(tasks) && tasks.length > 0) return null;
  if (status !== null && status.outcome !== null && status.outcome !== undefined) return null;
  if (blocksSoFar >= MAX_STOP_BLOCKS) return null;
  const where =
    status === null
      ? `${statusFile} has not been written yet`
      : `${statusFile} has no outcome yet (phase: ${String(status.phase)})`;
  return {
    decision: "block",
    reason:
      `Marshall: ${where}. The run is not over. Continue the skill you were running from that ` +
      "phase, and write the final status (outcome set) before you stop.",
  };
}

/** Run the guard for real: read stdin and the files, bump the counter on a block. */
export function guard(statusFile: string, stdin: string): GuardVerdict | null {
  let payload: StopPayload;
  try {
    payload = JSON.parse(stdin) as StopPayload;
  } catch {
    return null;
  }
  const counter = blocksPath(statusFile);
  const verdict = decide(payload, readStatus(statusFile), statusFile, readCount(counter));
  if (verdict) {
    mkdirSync(dirname(counter), { recursive: true });
    writeFileSync(counter, String(readCount(counter) + 1));
  }
  return verdict;
}

if (import.meta.main) {
  const statusFile = process.argv[2];
  if (statusFile) {
    const verdict = guard(statusFile, await Bun.stdin.text());
    if (verdict) console.log(JSON.stringify(verdict));
  }
}
