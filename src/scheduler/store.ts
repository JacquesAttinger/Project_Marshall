// Last edited: 2026-09-20 15:25 CDT
// Row helpers for `claims`, `starts`, `events`, and `flags`. All scheduler SQL lives here.

import type { Database } from "bun:sqlite";
import { AGENT_IDS, type AgentId } from "../linear/index.ts";
import { CLAIMED, CLAIMING, type Claim, RELEASED, TERMINAL_CLAIM_STATES } from "./types.ts";

interface ClaimRow {
  issue_id: string;
  agent_id: string;
  slot: number;
  state: string;
  branch: string | null;
  worktree_path: string | null;
  bounces: number;
  resumes: number;
  claimed_at: string;
  updated_at: string;
}

function rowToClaim(r: ClaimRow): Claim {
  return {
    issueId: r.issue_id,
    agentId: r.agent_id as AgentId,
    slot: r.slot,
    state: r.state,
    branch: r.branch,
    worktreePath: r.worktree_path,
    bounces: r.bounces,
    resumes: r.resumes,
    claimedAt: r.claimed_at,
    updatedAt: r.updated_at,
  };
}

const LIVE = `state NOT IN (${TERMINAL_CLAIM_STATES.map((s) => `'${s}'`).join(", ")})`;

export function isLive(claim: Claim): boolean {
  return !TERMINAL_CLAIM_STATES.includes(claim.state);
}

export function agentIdForSlot(slot: number): AgentId {
  const id = AGENT_IDS[slot];
  if (!id) throw new Error(`No agent id for slot ${slot}`);
  return id;
}

export function getClaim(db: Database, issueId: string): Claim | null {
  const row = db.query<ClaimRow, [string]>("SELECT * FROM claims WHERE issue_id = ?").get(issueId);
  return row ? rowToClaim(row) : null;
}

/** Claims that hold a slot, oldest first. */
export function liveClaims(db: Database): Claim[] {
  return db
    .query<ClaimRow, []>(`SELECT * FROM claims WHERE ${LIVE} ORDER BY claimed_at`)
    .all()
    .map(rowToClaim);
}

/** The lowest slot in [0, maxAgents) with no live claim, or null when every slot is taken. */
export function lowestFreeSlot(db: Database, maxAgents: number): number | null {
  const taken = new Set(liveClaims(db).map((c) => c.slot));
  for (let slot = 0; slot < maxAgents; slot++) {
    if (!taken.has(slot)) return slot;
  }
  return null;
}

/**
 * The write-ahead row: `claiming` on a slot, before Linear is touched. A fresh issue gets a new
 * row; a returning one (bounce, or a released row with no branch) is moved back onto a slot with
 * its history kept. The `claims_live_slot` index rejects a slot another process took meanwhile.
 */
export function beginClaim(db: Database, issueId: string, slot: number, now: string): Claim {
  db.run(
    `INSERT INTO claims (issue_id, agent_id, slot, state, claimed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET
       agent_id = excluded.agent_id, slot = excluded.slot, state = excluded.state,
       claimed_at = excluded.claimed_at, updated_at = excluded.updated_at`,
    [issueId, agentIdForSlot(slot), slot, CLAIMING, now, now],
  );
  return getClaim(db, issueId) as Claim;
}

/** Undo `beginClaim`: restore the previous row, or delete the one it created. */
export function abandonClaim(db: Database, issueId: string, previous: Claim | null, now: string) {
  if (!previous) {
    db.run("DELETE FROM claims WHERE issue_id = ?", [issueId]);
    return;
  }
  db.run(
    `UPDATE claims SET agent_id = ?, slot = ?, state = ?, claimed_at = ?, updated_at = ?
     WHERE issue_id = ?`,
    [previous.agentId, previous.slot, previous.state, previous.claimedAt, now, issueId],
  );
}

export interface FinishClaimInput {
  branch: string;
  worktreePath: string;
  /** A bounce restart: count it and reset the resume budget for the new lifecycle. */
  bounce: boolean;
}

/** The claim is real: Linear says In Progress with our label and the worktree exists. */
export function finishClaim(db: Database, issueId: string, input: FinishClaimInput, now: string) {
  const bounce = input.bounce ? 1 : 0;
  db.run(
    `UPDATE claims SET state = ?, branch = ?, worktree_path = ?,
       bounces = bounces + ?, resumes = CASE WHEN ? THEN 0 ELSE resumes END, updated_at = ?
     WHERE issue_id = ?`,
    [CLAIMED, input.branch, input.worktreePath, bounce, bounce, now, issueId],
  );
  return getClaim(db, issueId) as Claim;
}

export function setClaimState(db: Database, issueId: string, state: string, now: string): Claim {
  db.run("UPDATE claims SET state = ?, updated_at = ? WHERE issue_id = ?", [state, now, issueId]);
  return getClaim(db, issueId) as Claim;
}

export function releaseClaim(db: Database, issueId: string, now: string): Claim {
  return setClaimState(db, issueId, RELEASED, now);
}

export function bumpResumes(db: Database, issueId: string, now: string): Claim {
  db.run("UPDATE claims SET resumes = resumes + 1, updated_at = ? WHERE issue_id = ?", [
    now,
    issueId,
  ]);
  return getClaim(db, issueId) as Claim;
}

/** A human moved a blocked issue back to Todo: forgive the bounces and let it run again. */
export function resetBounces(db: Database, issueId: string, now: string): Claim {
  db.run("UPDATE claims SET bounces = 0, updated_at = ? WHERE issue_id = ?", [now, issueId]);
  return getClaim(db, issueId) as Claim;
}

/** One row per first-time start. Bounces and resumes do not count (decision 3). */
export function insertStart(db: Database, issueId: string, startedAt: string): void {
  db.run("INSERT INTO starts (issue_id, started_at) VALUES (?, ?)", [issueId, startedAt]);
}

export function countStartsBetween(db: Database, fromInclusive: string, toExclusive: string) {
  const row = db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM starts WHERE started_at >= ? AND started_at < ?",
    )
    .get(fromInclusive, toExclusive);
  return row?.n ?? 0;
}

/** Oldest start at or after `since`, as ISO, or null. Tells when the window frees a slot. */
export function oldestStartSince(db: Database, since: string): string | null {
  const row = db
    .query<{ t: string | null }, [string]>(
      "SELECT MIN(started_at) AS t FROM starts WHERE started_at >= ?",
    )
    .get(since);
  return row?.t ?? null;
}

/** Scheduler events are audit rows: `type = scheduler.<name>` or `reconcile.<name>`. */
export function insertEvent(
  db: Database,
  ts: string,
  type: string,
  issueId: string | null,
  agentId: string | null,
  payload: Record<string, unknown> = {},
): void {
  db.run("INSERT INTO events (ts, issue_id, agent_id, type, payload) VALUES (?, ?, ?, ?, ?)", [
    ts,
    issueId,
    agentId,
    type,
    JSON.stringify(payload),
  ]);
}

export function getFlag(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM flags WHERE key = ?")
    .get(key);
  return row?.value ?? null;
}

export function setFlag(db: Database, key: string, value: string | null): void {
  if (value === null) {
    db.run("DELETE FROM flags WHERE key = ?", [key]);
    return;
  }
  db.run(
    "INSERT INTO flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}
