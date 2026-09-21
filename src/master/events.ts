// Last edited: 2026-09-21 00:20 CDT
// Claim transitions and master events, for the agent objects and for the DB-driven rebase
// pulse alike. Every event lands in the `events` table as `master.<name>`.

import type { Database } from "bun:sqlite";
import type { Logger } from "../log.ts";
import { type Claim, insertEvent, setClaimState } from "../scheduler/index.ts";
import type { MasterEvent } from "./types.ts";

export interface EventDeps {
  db: Database;
  log: Logger;
  now: () => Date;
}

export function emitMaster(
  deps: EventDeps,
  claim: Claim,
  event: MasterEvent,
  payload: Record<string, unknown> = {},
): void {
  insertEvent(
    deps.db,
    deps.now().toISOString(),
    `master.${event}`,
    claim.issueId,
    claim.agentId,
    payload,
  );
}

/** Write the new state and one `phase_changed` event naming both ends. Returns the fresh row. */
export function transitionClaim(
  deps: EventDeps,
  claim: Claim,
  state: string,
  payload: Record<string, unknown> = {},
): Claim {
  const from = claim.state;
  const next = setClaimState(deps.db, claim.issueId, state, deps.now().toISOString());
  emitMaster(deps, next, "phase_changed", { from, to: state, ...payload });
  deps.log.info("master.phase_changed", { issueId: claim.issueId, from, to: state });
  return next;
}
