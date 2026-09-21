// Last edited: 2026-09-21 01:10 CDT
// Master agent test setup: an in-memory DB, a temp MARSHALL_HOME, a fake clock, and fakes for
// every injectable seam (runner, waiter, git, gh, the plan and hand-off phases, Linear). Runs are
// rows the fake runner inserts; a test ends one with `finish(runId, terminal)`.

import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, parseConfig } from "../../src/config.ts";
import { migrate, openDb } from "../../src/db/index.ts";
import type {
  HandoffPhaseInput,
  HandoffPhaseResult,
  PostInput,
  PostResult,
} from "../../src/handoff/index.ts";
import { type ImplementStatus, implementStatusPath } from "../../src/implement/status.ts";
import type { CreatedIssue, FollowUpInput, PickableIssue } from "../../src/linear/index.ts";
import { createOrchestrator, type Orchestrator } from "../../src/master/orchestrator.ts";
import type { GitOps, MasterDeps, RunnerOps } from "../../src/master/types.ts";
import type { PlanPhaseInput, PlanPhaseResult, RunWaiter } from "../../src/plan/index.ts";
import { terminalOf } from "../../src/plan/wait.ts";
import { insertRun, updateRun } from "../../src/runner/store.ts";
import type { LaunchOpts, ResumeOpts, Terminal } from "../../src/runner/types.ts";
import { beginClaim, finishClaim } from "../../src/scheduler/store.ts";
import type { Claim } from "../../src/scheduler/types.ts";
import { type LogLine, recordingLogger, type TempHome, useTempHome } from "../helpers.ts";
import { type FakeLinearClient, fakeClient, pickable } from "../scheduler/fake-client.ts";

export const NOW = new Date(2026, 8, 20, 14, 0, 0);
export const PR_URL = "https://github.com/example/chessbuddy/pull/12";
export const PLAN = "docs/fix-castling_plan.md";

export interface FakeRunner extends RunnerOps {
  launches: { runId: string; opts: LaunchOpts }[];
  resumes: { runId: string; opts: ResumeOpts }[];
  kills: string[];
  /** Run ids `isStalled` answers true for. */
  stalled: Set<string>;
  /** Throw from the next launch with this message. */
  failLaunch: string | null;
}

export interface FakeWaiter extends RunWaiter {
  /** End a run: the row is marked and the pending wait (if any) resolves. */
  finish(runId: string, terminal: Terminal): void;
  pending(): string[];
}

export interface FakeGit extends GitOps {
  calls: { op: string; args: string[] }[];
  /** `rebase` answers false (conflict) while set. */
  conflict: boolean;
  subjectOfHead: string;
}

export interface PrViewStub {
  mergedAt?: string | null;
  state?: string;
  statusCheckRollup?: unknown[];
}

export interface FakeGh {
  calls: string[][];
  views: Map<string, PrViewStub>;
  run(args: string[], cwd: string): Promise<string>;
}

export interface FakePhases {
  planCalls: PlanPhaseInput[];
  handoffCalls: HandoffPhaseInput[];
  postCalls: PostInput[];
  planResults: PlanPhaseResult[];
  handoffResults: HandoffPhaseResult[];
  postResult: PostResult;
  plan(input: PlanPhaseInput): Promise<PlanPhaseResult>;
  handoff(input: HandoffPhaseInput): Promise<HandoffPhaseResult>;
  postHandoff(input: PostInput): Promise<PostResult>;
}

export interface MasterHarness {
  db: Database;
  config: Config;
  home: TempHome;
  deps: MasterDeps;
  linear: FakeLinearClient & { followUps: FollowUpInput[] };
  runner: FakeRunner;
  waiter: FakeWaiter;
  git: FakeGit;
  gh: FakeGh;
  phases: FakePhases;
  lines: LogLine[];
  clock: { now: Date };
  hooks: Orchestrator;
  tickClock(ms: number): void;
  /** Build a second orchestrator over the same DB, as a restart would. */
  restart(): Orchestrator;
  close(): void;
}

let runSeq = 0;

function makeRunner(db: Database): FakeRunner {
  const runner: FakeRunner = {
    launches: [],
    resumes: [],
    kills: [],
    stalled: new Set(),
    failLaunch: null,
    async launch(_db, opts) {
      if (runner.failLaunch) {
        const message = runner.failLaunch;
        runner.failLaunch = null;
        throw new Error(message);
      }
      runSeq += 1;
      const runId = opts.runId ?? `run-${runSeq}`;
      insertRun(db, { runId, name: opts.name, cwd: opts.cwd });
      const run = updateRun(db, runId, {
        jobId: `job${runSeq}`,
        sessionId: `session-${runSeq}`,
        state: "running",
      });
      runner.launches.push({ runId, opts });
      return run;
    },
    async resume(_db, opts) {
      runSeq += 1;
      const runId = `run-${runSeq}`;
      insertRun(db, { runId, name: opts.name, cwd: opts.cwd, resumedFrom: opts.sessionId });
      const run = updateRun(db, runId, {
        jobId: `job${runSeq}`,
        sessionId: `session-${runSeq}`,
        state: "running",
      });
      runner.resumes.push({ runId, opts });
      return run;
    },
    async kill(_db, runId) {
      runner.kills.push(runId);
      return updateRun(db, runId, { state: "killed", finishedAt: new Date().toISOString() });
    },
    async isStalled(_db, runId) {
      return runner.stalled.has(runId);
    },
  };
  return runner;
}

function makeWaiter(db: Database): FakeWaiter {
  const pending = new Map<string, (t: Terminal | null) => void>();
  return {
    wait(runId, _timeoutMs) {
      const already = terminalOf(db, runId);
      if (already) return Promise.resolve(already);
      return new Promise((resolve) => {
        pending.set(runId, resolve);
      });
    },
    settle(runId, terminal) {
      const resolve = pending.get(runId);
      if (!resolve) return false;
      pending.delete(runId);
      resolve(terminal);
      return true;
    },
    finish(runId, terminal) {
      updateRun(db, runId, {
        state: terminal.kind === "finished" ? "finished" : "failed",
        error: terminal.kind === "failed" ? terminal.error : null,
        finishedAt: new Date().toISOString(),
      });
      if (terminal.kind === "failed" && terminal.details) {
        db.run("INSERT INTO events (ts, agent_id, type, payload) VALUES (?, ?, ?, ?)", [
          new Date().toISOString(),
          runId,
          "hook.StopFailure",
          JSON.stringify({ error: terminal.error, error_details: terminal.details }),
        ]);
      }
      this.settle(runId, terminal);
    },
    pending: () => [...pending.keys()],
    stop() {},
  };
}

function makeGit(): FakeGit {
  const git: FakeGit = {
    calls: [],
    conflict: false,
    subjectOfHead: "Implement the thing",
    async fetch(cwd) {
      git.calls.push({ op: "fetch", args: [cwd] });
    },
    async head(cwd) {
      git.calls.push({ op: "head", args: [cwd] });
      return "headsha";
    },
    async subject(cwd, ref) {
      git.calls.push({ op: "subject", args: [cwd, ref] });
      return git.subjectOfHead;
    },
    async lastCommitTouching(cwd, path) {
      git.calls.push({ op: "lastCommitTouching", args: [cwd, path] });
      return "plansha";
    },
    async resetHard(cwd, ref) {
      git.calls.push({ op: "resetHard", args: [cwd, ref] });
    },
    async rebase(cwd, base) {
      git.calls.push({ op: "rebase", args: [cwd, base] });
      return !git.conflict;
    },
    async abortRebase(cwd) {
      git.calls.push({ op: "abortRebase", args: [cwd] });
    },
    async forcePush(cwd) {
      git.calls.push({ op: "forcePush", args: [cwd] });
    },
  };
  return git;
}

function makeGh(): FakeGh {
  const gh: FakeGh = {
    calls: [],
    views: new Map(),
    async run(args) {
      gh.calls.push(args);
      if (args[0] === "pr" && args[1] === "view") {
        const stub = gh.views.get(args[2] as string) ?? {};
        return JSON.stringify({
          mergedAt: stub.mergedAt ?? null,
          state: stub.state ?? "OPEN",
          statusCheckRollup: stub.statusCheckRollup ?? [
            { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
          body: "",
        });
      }
      return "";
    },
  };
  return gh;
}

export function okPlan(overrides: Partial<Extract<PlanPhaseResult, { ok: true }>> = {}) {
  return {
    ok: true as const,
    planPath: PLAN,
    classification: null,
    model: "opus",
    runId: "plan-run",
    briefPath: "",
    ...overrides,
  };
}

export function okHandoff(overrides: Partial<Extract<HandoffPhaseResult, { ok: true }>> = {}) {
  return {
    ok: true as const,
    handoffPath: "/tmp/handoff.md",
    metaPath: "/tmp/handoff.json",
    commentId: "comment-1",
    round: 1,
    prUrl: PR_URL,
    model: "opus",
    runId: "handoff-run",
    resumed: false,
    ...overrides,
  };
}

function makePhases(): FakePhases {
  const phases: FakePhases = {
    planCalls: [],
    handoffCalls: [],
    postCalls: [],
    planResults: [],
    handoffResults: [],
    postResult: {
      ok: true,
      commentId: "comment-1",
      commentAction: "updated",
      prAction: "replaced",
      metaPath: "/tmp/meta.json",
      text: "",
    },
    async plan(input) {
      phases.planCalls.push(input);
      return phases.planResults.shift() ?? okPlan();
    },
    async handoff(input) {
      phases.handoffCalls.push(input);
      const result = phases.handoffResults.shift() ?? okHandoff();
      if (result.ok) result.round = input.round ?? result.round;
      return result;
    },
    async postHandoff(input) {
      phases.postCalls.push(input);
      return phases.postResult;
    },
  };
  return phases;
}

export interface HarnessOptions {
  config?: Record<string, unknown>;
  now?: Date;
}

export function makeMasterHarness(opts: HarnessOptions = {}): MasterHarness {
  const home = useTempHome("marshall-master-");
  const db = openDb(":memory:");
  migrate(db);
  const config = parseConfig({
    workspace: "chessbuddy",
    teamId: "t",
    repoPath: home.dir,
    ...opts.config,
  });
  const base = fakeClient();
  const followUps: FollowUpInput[] = [];
  const linear = Object.assign(base, {
    followUps,
    async updateComment() {},
    async createFollowUp(_origin: string, input: FollowUpInput): Promise<CreatedIssue> {
      followUps.push(input);
      return { id: `f-${followUps.length}`, identifier: `CB-9${followUps.length}`, url: "u" };
    },
  });
  const { log, lines } = recordingLogger();
  const clock = { now: opts.now ?? NOW };
  const runner = makeRunner(db);
  const waiter = makeWaiter(db);
  const git = makeGit();
  const gh = makeGh();
  const phases = makePhases();
  const deps: MasterDeps = {
    db,
    config,
    linear,
    log,
    now: () => clock.now,
    waiter,
    runner,
    git,
    gh: (args, cwd) => gh.run(args, cwd),
    phases,
  };
  return {
    db,
    config,
    home,
    deps,
    linear,
    runner,
    waiter,
    git,
    gh,
    phases,
    lines,
    clock,
    hooks: createOrchestrator(deps),
    tickClock: (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    restart: () => createOrchestrator(deps),
    close: () => {
      db.close();
      home.restore();
    },
  };
}

/** A pickable issue registered with the fake Linear as In Progress under the slot's label. */
export function registerIssue(h: MasterHarness, identifier: string, slot = 0): PickableIssue {
  const issue = pickable({ identifier });
  h.linear.issues.set(issue.id, {
    issue,
    state: { name: "In Progress", type: "started" },
    labels: [`marshall/agent-${slot}`],
  });
  return issue;
}

/** A claim as the scheduler leaves it before `hooks.start`: claimed, worktree made. */
export function claimFor(h: MasterHarness, issue: PickableIssue, slot = 0, bounce = false): Claim {
  const now = h.clock.now.toISOString();
  beginClaim(h.db, issue.id, slot, now);
  return finishClaim(
    h.db,
    issue.id,
    {
      identifier: issue.identifier,
      branch: issue.branchName,
      worktreePath: `${h.home.dir}/wt-${issue.identifier}`,
      bounce,
    },
    now,
  );
}

export function writeStatus(identifier: string, overrides: Partial<ImplementStatus> = {}): void {
  const status: ImplementStatus = {
    issueId: identifier,
    slot: 0,
    phase: "done",
    cycle: 1,
    maxCycles: 4,
    branch: `cb-${identifier.replace(/\D/g, "")}-issue`,
    prUrl: PR_URL,
    prDraft: false,
    ciState: "green",
    outcome: "pr_green",
    reason: null,
    followups: [{ title: "Mirror the queen-side test", body: "Same path, other rook." }],
    reviewNotes: [],
    updatedAt: "2026-09-20T17:00:00Z",
    ...overrides,
  };
  const path = implementStatusPath(identifier);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(status, null, 2));
}

/**
 * Spin the event loop until `cond` holds, or fail after `ms`. One more turn is given after the
 * condition holds so the driver's microtask chain (launch → wait) settles before the test acts.
 */
export async function until(cond: () => boolean, ms = 2000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
  await Bun.sleep(2);
}

export function masterEvents(db: Database, issueId?: string): string[] {
  const rows = issueId
    ? db
        .query<{ type: string }, [string]>(
          "SELECT type FROM events WHERE type LIKE 'master.%' AND issue_id = ? ORDER BY id",
        )
        .all(issueId)
    : db
        .query<{ type: string }, []>(
          "SELECT type FROM events WHERE type LIKE 'master.%' ORDER BY id",
        )
        .all();
  return rows.map((r) => r.type.slice("master.".length));
}

export function eventPayloads(db: Database, type: string): Record<string, unknown>[] {
  return db
    .query<{ payload: string }, [string]>("SELECT payload FROM events WHERE type = ? ORDER BY id")
    .all(`master.${type}`)
    .map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}
