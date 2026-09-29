// Last edited: 2026-09-29 19:05 CDT
// Moves an issue to Done when its PR merges, by two paths. The merge poll (`rebase.ts`) calls
// `markDone` the moment it sees a parked PR merge. `sweepDone` catches the merges that poll
// missed (Marshall was off, or the claim was reused for a re-run): every `doneSweepMinutes` it
// looks at this user's Needs Verification and Blocked issues and finds each one's PR by title.

import type { MasterDeps } from "../master/types.ts";
import { BLOCKED, getClaim, RELEASED } from "../scheduler/index.ts";
import { getFlag, insertEvent, setFlag } from "../scheduler/store.ts";
import { type FoundPr, findPrsFor } from "./pr.ts";

export const DONE_SWEEP_FLAG = "done_sweep_at";

type DoneDeps = Pick<MasterDeps, "db" | "linear" | "log" | "now">;

/** Set the issue Done with one comment naming the PR, and record `master.done`. */
export async function markDone(
  deps: DoneDeps,
  issue: { id: string; identifier: string },
  prUrl: string,
  mergedAt: string | null,
  source: "merge_poll" | "sweep",
  agentId: string | null = null,
): Promise<void> {
  const when = mergedAt ? ` at ${mergedAt}` : "";
  await deps.linear.complete(issue.id, { comment: `Marked Done: ${prUrl} merged${when}.` });
  insertEvent(deps.db, deps.now().toISOString(), "master.done", issue.id, agentId, {
    prUrl,
    source,
  });
  deps.log.info("master.done", { issueId: issue.id, identifier: issue.identifier, prUrl, source });
}

/** True while the sweep must leave the issue alone: any claim that is not released or blocked. */
function hasActiveClaim(deps: MasterDeps, issueId: string): boolean {
  const state = getClaim(deps.db, issueId)?.state;
  return state !== undefined && state !== RELEASED && state !== BLOCKED;
}

/** The merged PR to credit, or null when none merged or another PR for the issue is still open. */
export function mergedPrOf(prs: FoundPr[]): FoundPr | null {
  if (prs.some((pr) => pr.state === "OPEN")) return null;
  return prs.find((pr) => pr.mergedAt || pr.state === "MERGED") ?? null;
}

function sweepDue(deps: MasterDeps): boolean {
  const last = getFlag(deps.db, DONE_SWEEP_FLAG);
  if (!last) return true;
  return deps.now().getTime() - Date.parse(last) >= deps.config.doneSweepMinutes * 60_000;
}

/** Never throws: one bad Linear or `gh` call is logged and the pulse goes on. */
export async function sweepDone(deps: MasterDeps): Promise<void> {
  if (!sweepDue(deps)) return;
  // Stamped before the calls, so a failing sweep waits its interval instead of hammering.
  setFlag(deps.db, DONE_SWEEP_FLAG, deps.now().toISOString());
  let candidates: Awaited<ReturnType<MasterDeps["linear"]["listAwaitingMerge"]>>;
  try {
    candidates = await deps.linear.listAwaitingMerge();
  } catch (err) {
    deps.log.warn("master.done_sweep_failed", { error: (err as Error).message });
    return;
  }
  for (const issue of candidates) {
    if (hasActiveClaim(deps, issue.id)) continue;
    try {
      const prs = await findPrsFor(deps.gh, issue.identifier, deps.config.repoPath);
      const merged = mergedPrOf(prs);
      if (merged) await markDone(deps, issue, merged.url, merged.mergedAt, "sweep");
    } catch (err) {
      deps.log.warn("master.done_sweep_failed", {
        issueId: issue.id,
        error: (err as Error).message,
      });
    }
  }
}
