// Last edited: 2026-09-20 23:25 CDT
// What the orchestrator does with implement.json around a run: put it in the shape the skill
// reads as "resume, reuse the PR" before a bounce or a fresh restart, and read the outcome after.

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type ImplementOutcome,
  type ImplementStatus,
  ImplementStatusSchema,
  implementStatusPath,
  readImplementStatus,
} from "../implement/status.ts";

/**
 * Rewrite implement.json as a resume point: `outcome: null`, `phase: starting`, `cycle: 0`, with
 * the PR, branch, follow-ups, and review notes kept. The skill's preflight then reuses the PR and
 * runs the whole loop again (decision 5: the full done gate on every bounce). The Stop guard's
 * block counter is reset with it.
 */
export function writeImplementResumeStatus(
  identifier: string,
  previous: ImplementStatus,
  now: Date = new Date(),
): string {
  const path = implementStatusPath(identifier);
  const next: ImplementStatus = ImplementStatusSchema.parse({
    ...previous,
    phase: "starting",
    cycle: 0,
    ciState: null,
    outcome: null,
    reason: null,
    prDraft: false,
    updatedAt: now.toISOString(),
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  rmSync(`${path}.stop-blocks`, { force: true });
  return path;
}

/** Before a bounce's implement run: if a finished status exists, turn it into a resume point. */
export function prepareBounceStatus(identifier: string, now: Date = new Date()): boolean {
  let previous: ImplementStatus | null = null;
  try {
    previous = readImplementStatus(identifier);
  } catch {
    return false;
  }
  if (!previous || previous.outcome === null) return false;
  writeImplementResumeStatus(identifier, previous, now);
  return true;
}

export type ImplementRead =
  | { ok: true; status: ImplementStatus; outcome: ImplementOutcome }
  | { ok: false; reason: "no_status" | "no_outcome" | "malformed"; detail: string };

/** The finished status after a run's Stop, or why it cannot be used. Never throws. */
export function readImplementOutcome(identifier: string): ImplementRead {
  let status: ImplementStatus | null;
  try {
    status = readImplementStatus(identifier);
  } catch (err) {
    return { ok: false, reason: "malformed", detail: (err as Error).message };
  }
  if (!status) return { ok: false, reason: "no_status", detail: "no implement.json after the run" };
  if (status.outcome === null) {
    return { ok: false, reason: "no_outcome", detail: `run ended in phase ${status.phase}` };
  }
  return { ok: true, status, outcome: status.outcome };
}
