// Last edited: 2026-09-20 22:50 CDT
// Scheduler test setup: in-memory DB, fake Linear, fake worktrees, recording hooks, fake clock.

import type { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { type Config, parseConfig } from "../../src/config.ts";
import { migrate, openDb } from "../../src/db/index.ts";
import type { PickableIssue } from "../../src/linear/index.ts";
import type { Claim, SchedulerDeps, WorktreeSpec } from "../../src/scheduler/types.ts";
import { type LogLine, recordingLogger } from "../helpers.ts";
import { type FakeLinearClient, fakeClient } from "./fake-client.ts";

export interface Harness {
  deps: SchedulerDeps;
  db: Database;
  config: Config;
  linear: FakeLinearClient;
  lines: LogLine[];
  starts: { claim: Claim; issue: PickableIssue }[];
  resumes: Claim[];
  attaches: Claim[];
  worktreeCalls: { op: "create" | "reuse"; spec: WorktreeSpec }[];
  /** Issue ids whose agent the fake runner reports alive. */
  alive: Set<string>;
  /** Advance the fake clock. */
  tickClock(ms: number): void;
  clock: { now: Date };
  close(): void;
}

export interface HarnessOptions {
  issues?: PickableIssue[];
  config?: Record<string, unknown>;
  now?: Date;
  /** Throw from worktree ops for these branches. */
  failWorktree?: Set<string>;
  /** Throw from hooks.start for these issue ids. */
  failStart?: Set<string>;
  /** Throw from hooks.resume for these issue ids. */
  failResume?: Set<string>;
  /** Throw from runner.isAlive for these issue ids. */
  failLiveness?: Set<string>;
}

export const NOW = new Date(2026, 8, 20, 14, 0, 0);

export function makeHarness(opts: HarnessOptions = {}): Harness {
  const db = openDb(":memory:");
  migrate(db);
  const config = parseConfig({
    workspace: "w",
    teamId: "t",
    repoPath: tmpdir(),
    ...opts.config,
  });
  const linear = fakeClient(opts.issues ?? []);
  const { log, lines } = recordingLogger();
  const clock = { now: opts.now ?? NOW };
  const starts: Harness["starts"] = [];
  const resumes: Claim[] = [];
  const attaches: Claim[] = [];
  const worktreeCalls: Harness["worktreeCalls"] = [];
  const alive = new Set<string>();
  const worktreeOp = (op: "create" | "reuse") => async (spec: WorktreeSpec) => {
    worktreeCalls.push({ op, spec });
    if (opts.failWorktree?.has(spec.branch)) throw new Error(`git failed for ${spec.branch}`);
    return `${spec.repoPath}-${spec.branch}`;
  };
  const deps: SchedulerDeps = {
    db,
    config,
    linear,
    log,
    now: () => clock.now,
    worktrees: { create: worktreeOp("create"), reuse: worktreeOp("reuse") },
    hooks: {
      async start(claim, issue) {
        if (opts.failStart?.has(claim.issueId)) throw new Error(`start failed ${claim.issueId}`);
        starts.push({ claim, issue });
      },
      async resume(claim) {
        if (opts.failResume?.has(claim.issueId)) throw new Error(`resume failed ${claim.issueId}`);
        resumes.push(claim);
      },
      async attach(claim) {
        attaches.push(claim);
      },
    },
    runner: {
      async isAlive(claim) {
        if (opts.failLiveness?.has(claim.issueId)) throw new Error("claude agents failed");
        return alive.has(claim.issueId);
      },
    },
  };
  return {
    deps,
    db,
    config,
    linear,
    lines,
    starts,
    resumes,
    attaches,
    worktreeCalls,
    alive,
    clock,
    tickClock: (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    close: () => db.close(),
  };
}

/** Put a fake issue back in Todo with no agent label, as a human bounce does. */
export function todoAgain(h: Harness, issueId: string): void {
  const entry = h.linear.issues.get(issueId);
  if (!entry) throw new Error(`no fake issue ${issueId}`);
  entry.state = { name: "Todo", type: "unstarted" };
  entry.labels = [];
}

/** Insert a claim row directly, for reconcile and bounce setups. */
export function seedClaim(
  db: Database,
  row: Partial<Claim> & { issueId: string; slot: number; state: string },
): void {
  db.run(
    `INSERT INTO claims (issue_id, agent_id, slot, state, branch, worktree_path, bounces, resumes,
       identifier, fresh_restarts, plan_path, model, pr_url, rebase_after, claimed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.issueId,
      row.agentId ?? `agent-${row.slot}`,
      row.slot,
      row.state,
      row.branch ?? null,
      row.worktreePath ?? null,
      row.bounces ?? 0,
      row.resumes ?? 0,
      row.identifier ?? null,
      row.freshRestarts ?? 0,
      row.planPath ?? null,
      row.model ?? null,
      row.prUrl ?? null,
      row.rebaseAfter ?? null,
      row.claimedAt ?? NOW.toISOString(),
      row.updatedAt ?? NOW.toISOString(),
    ],
  );
}

export function eventTypes(db: Database): string[] {
  return db
    .query<{ type: string }, []>("SELECT type FROM events ORDER BY id")
    .all()
    .map((r) => r.type);
}

export function startRows(db: Database): { issue_id: string; started_at: string }[] {
  return db
    .query<{ issue_id: string; started_at: string }, []>(
      "SELECT issue_id, started_at FROM starts ORDER BY id",
    )
    .all();
}
