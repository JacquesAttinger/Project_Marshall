// Last edited: 2026-09-21 00:20 CDT
// One `gh pr view` per poll answers both questions the rebase pulse asks: did this PR merge or
// close, and is its CI green, red, or still running.

import type { GhRunner } from "../handoff/index.ts";

export type CiState = "green" | "red" | "pending";

export interface PrView {
  mergedAt: string | null;
  /** `OPEN`, `MERGED`, or `CLOSED`. */
  state: string;
  ci: CiState;
}

/** GitHub registers check runs a moment after a push; an empty rollup inside this is pending. */
export const CI_REGISTER_GRACE_MS = 2 * 60_000;

const RED_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

function checkState(entry: Record<string, unknown>): CiState {
  if (entry.__typename === "StatusContext") {
    const state = String(entry.state ?? "");
    if (state === "SUCCESS") return "green";
    if (state === "FAILURE" || state === "ERROR") return "red";
    return "pending";
  }
  if (String(entry.status ?? "") !== "COMPLETED") return "pending";
  return RED_CONCLUSIONS.has(String(entry.conclusion ?? "")) ? "red" : "green";
}

/**
 * Fold a `statusCheckRollup` array: any red → red; else any pending → pending; else green.
 * An empty rollup is pending while the push is younger than the grace period, else green.
 */
export function ciStateOf(rollup: unknown, pushedAt: string, now: Date): CiState {
  const entries = Array.isArray(rollup) ? (rollup as Record<string, unknown>[]) : [];
  if (entries.length === 0) {
    return now.getTime() - Date.parse(pushedAt) < CI_REGISTER_GRACE_MS ? "pending" : "green";
  }
  const states = entries.map(checkState);
  if (states.includes("red")) return "red";
  if (states.includes("pending")) return "pending";
  return "green";
}

export async function viewPr(
  gh: GhRunner,
  prUrl: string,
  cwd: string,
  pushedAt: string,
  now: Date,
): Promise<PrView> {
  const out = await gh(["pr", "view", prUrl, "--json", "mergedAt,state,statusCheckRollup"], cwd);
  const parsed = JSON.parse(out) as Record<string, unknown>;
  return {
    mergedAt: typeof parsed.mergedAt === "string" ? parsed.mergedAt : null,
    state: String(parsed.state ?? "OPEN"),
    ci: ciStateOf(parsed.statusCheckRollup, pushedAt, now),
  };
}
