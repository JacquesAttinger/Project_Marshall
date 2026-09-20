// Last edited: 2026-09-20 16:40 CDT
// The hand-off phase: read implement.json → snapshot the worktree → launch `/marshall:handoff` →
// wait → prove the worktree did not change → validate the file → resume once with the problems
// if it is invalid → post. Mirrors src/plan/phase.ts; step 08 makes one call, runHandoffPhase.

import { type Config, handoffModel } from "../config.ts";
import { GitError, gitLines, runGit } from "../git.ts";
import { readImplementStatus } from "../implement/status.ts";
import type { IssueDetail } from "../linear/index.ts";
import { createLogger } from "../log.ts";
import { handoffPath, issueDir } from "../paths.ts";
import { PLUGIN_DIR } from "../plan/phase.ts";
import { createRunWaiter } from "../plan/wait.ts";
import { getRun, kill, launch, mintRunId, type Run, resume } from "../runner/index.ts";
import { readHandoffMeta } from "./meta.ts";
import { postHandoff } from "./post.ts";
import type {
  HandoffFailure,
  HandoffPhaseInput,
  HandoffPhaseResult,
  WriteInput,
  WriteOutcome,
} from "./types.ts";
import { checkHandoffFile } from "./validate.ts";

const log = createLogger({ module: "handoff" });

/** The floor for the resume's wait, whatever is left of the phase clock. */
const RESUME_MIN_MS = 2 * 60_000;

/** What the writer skill reads from its environment (see plugin/skills/handoff/SKILL.md). */
export function handoffEnv(
  issue: Pick<IssueDetail, "identifier" | "url">,
  prUrl: string,
  round: number,
  config: Config,
): Record<string, string> {
  return {
    MARSHALL_ISSUE_DIR: issueDir(issue.identifier),
    MARSHALL_ISSUE_URL: issue.url,
    MARSHALL_HANDOFF_PATH: handoffPath(issue.identifier),
    MARSHALL_ROUND: String(round),
    MARSHALL_BASE_BRANCH: config.baseBranch,
    MARSHALL_PR_URL: prUrl,
  };
}

type Ctx = WriteInput & {
  runId: string;
  model: string;
  prUrl: string;
  branch: string;
  round: number;
  handoffPath: string;
  /** Epoch ms when the phase clock runs out. */
  deadline: number;
  waiter: NonNullable<WriteInput["waiter"]>;
};

type Failure = Extract<WriteOutcome, { ok: false }>;

function fail(
  ctx: Pick<Ctx, "runId" | "issue"> & Partial<Pick<Ctx, "handoffPath">>,
  reason: HandoffFailure,
  detail: string,
): Failure {
  log.warn("handoff.failed", { issue: ctx.issue.identifier, runId: ctx.runId, reason, detail });
  return { ok: false, reason, detail, runId: ctx.runId, handoffPath: ctx.handoffPath };
}

interface Snapshot {
  head: string;
  dirty: string[];
}

async function snapshot(cwd: string): Promise<Snapshot> {
  const [head, status] = await Promise.all([
    runGit(["rev-parse", "HEAD"], cwd),
    gitLines(["status", "--porcelain"], cwd),
  ]);
  return { head, dirty: status.map((l) => l.slice(3)) };
}

/** Null when the worktree is as it was; otherwise one line naming what moved. */
function drift(before: Snapshot, after: Snapshot): string | null {
  if (after.dirty.length > 0) return `uncommitted changes: ${after.dirty.join(", ")}`;
  if (after.head !== before.head) return `HEAD moved from ${before.head} to ${after.head}`;
  return null;
}

function launchOpts(ctx: Ctx, prompt: string) {
  return {
    name: `${ctx.issue.identifier} handoff`,
    cwd: ctx.cwd,
    model: ctx.model,
    prompt,
    extraArgs: ["--plugin-dir", PLUGIN_DIR],
    env: handoffEnv(ctx.issue, ctx.prUrl, ctx.round, ctx.config),
  };
}

/** Wait for the run's Stop. Null on success; a failure result on timeout or StopFailure. */
async function awaitRun(ctx: Ctx, run: Run, timeoutMs: number): Promise<Failure | null> {
  const terminal = await ctx.waiter.wait(run.runId, timeoutMs);
  if (!terminal) {
    await kill(ctx.db, run.runId);
    return fail(ctx, "timeout", `no Stop within ${Math.round(timeoutMs / 60_000)} min`);
  }
  if (terminal.kind === "failed") return fail(ctx, "run_failed", terminal.error);
  return null;
}

/** Re-snapshot and validate. Returns the problems (empty when valid) or a failure. */
async function inspect(ctx: Ctx, before: Snapshot): Promise<string[] | Failure> {
  const moved = drift(before, await snapshot(ctx.cwd));
  if (moved) return fail(ctx, "worktree_dirty", `after the run: ${moved}`);
  return checkHandoffFile(ctx.handoffPath, { prUrl: ctx.prUrl, branch: ctx.branch }).problems;
}

/** One resume with the validation problems as the prompt, then the same checks again. */
async function resumeOnce(ctx: Ctx, before: Snapshot, problems: string[]): Promise<Failure | null> {
  const sessionId = getRun(ctx.db, ctx.runId)?.sessionId;
  if (!sessionId) {
    return fail(ctx, "handoff_invalid", `${problems.join("; ")} (cannot resume: no session id)`);
  }
  const nudge =
    `The hand-off at ${ctx.handoffPath} failed validation: ${problems.join("; ")}. ` +
    "Fix that file in place. Write nothing else, then stop.";
  let run: Run;
  try {
    run = await resume(ctx.db, { ...launchOpts(ctx, nudge), sessionId });
  } catch (err) {
    return fail(ctx, "launch_failed", `resume: ${(err as Error).message}`);
  }
  ctx.onLaunched?.(run);
  log.info("handoff.resumed", { issue: ctx.issue.identifier, runId: run.runId, sessionId });
  const failed = await awaitRun(ctx, run, Math.max(RESUME_MIN_MS, ctx.deadline - Date.now()));
  if (failed) return failed;
  const again = await inspect(ctx, before);
  if (!Array.isArray(again)) return again;
  if (again.length > 0) return fail(ctx, "handoff_invalid", again.join("; "));
  return null;
}

/** Resolve the PR facts, the round, and the model. A failure here happens before any launch. */
function prepare(input: WriteInput): Ctx | Failure {
  const base = { runId: mintRunId(`${input.issue.identifier} handoff`), issue: input.issue };
  let status: ReturnType<typeof readImplementStatus>;
  try {
    status = readImplementStatus(input.issue.identifier);
  } catch (err) {
    return fail(base, "no_pr", (err as Error).message);
  }
  if (!status?.prUrl || !status.branch) {
    return fail(
      base,
      "no_pr",
      status ? "implement.json has no prUrl or branch" : "no implement.json",
    );
  }
  const round = input.round ?? (readHandoffMeta(input.issue.identifier)?.round ?? 0) + 1;
  return {
    ...input,
    ...base,
    model: input.model ?? handoffModel(input.config),
    prUrl: status.prUrl,
    branch: status.branch,
    round,
    handoffPath: handoffPath(input.issue.identifier),
    deadline: Date.now() + input.config.handoffMinutes * 60_000,
    waiter: input.waiter ?? createRunWaiter(input.db),
  };
}

async function writeWith(ctx: Ctx): Promise<WriteOutcome> {
  let before: Snapshot;
  try {
    before = await snapshot(ctx.cwd);
  } catch (err) {
    const message = err instanceof GitError ? err.message : String(err);
    return fail(ctx, "launch_failed", `git: ${message}`);
  }
  if (before.dirty.length > 0) {
    return fail(ctx, "worktree_dirty", `before launch: ${before.dirty.join(", ")}`);
  }
  let run: Run;
  try {
    const prompt = `/marshall:handoff ${ctx.planPath} ${ctx.issue.identifier}`;
    run = await launch(ctx.db, { runId: ctx.runId, ...launchOpts(ctx, prompt) });
  } catch (err) {
    return fail(ctx, "launch_failed", (err as Error).message);
  }
  ctx.onLaunched?.(run);
  const failed = await awaitRun(ctx, run, ctx.deadline - Date.now());
  if (failed) return failed;
  const problems = await inspect(ctx, before);
  if (!Array.isArray(problems)) return problems;
  let resumed = false;
  if (problems.length > 0) {
    log.info("handoff.invalid_once", { issue: ctx.issue.identifier, runId: ctx.runId, problems });
    const again = await resumeOnce(ctx, before, problems);
    if (again) return again;
    resumed = true;
  }
  log.info("handoff.written", { issue: ctx.issue.identifier, runId: ctx.runId, round: ctx.round });
  return {
    ok: true,
    handoffPath: ctx.handoffPath,
    round: ctx.round,
    prUrl: ctx.prUrl,
    branch: ctx.branch,
    model: ctx.model,
    runId: ctx.runId,
    resumed,
  };
}

/**
 * Run the writer and validate its file; nothing is posted. `onLaunched` fires for the first run
 * and again for the resume, so a caller can track both. Never throws for an agent's mistakes.
 */
export async function writeHandoff(input: WriteInput): Promise<WriteOutcome> {
  const ctx = prepare(input);
  if ("ok" in ctx) return ctx;
  try {
    return await writeWith(ctx);
  } finally {
    if (!input.waiter) ctx.waiter.stop();
  }
}

/** The whole phase: writeHandoff, then postHandoff to Linear and the PR body. */
export async function runHandoffPhase(input: HandoffPhaseInput): Promise<HandoffPhaseResult> {
  const written = await writeHandoff(input);
  if (!written.ok) return written;
  const posted = await postHandoff({
    issue: input.issue,
    linear: input.linear,
    handoffPath: written.handoffPath,
    prUrl: written.prUrl,
    cwd: input.cwd,
    round: written.round,
    gh: input.gh,
  });
  if (!posted.ok) {
    return fail(
      { runId: written.runId, handoffPath: written.handoffPath, issue: input.issue },
      "post_failed",
      `${posted.reason}: ${posted.detail}`,
    );
  }
  log.info("handoff.done", {
    issue: input.issue.identifier,
    runId: written.runId,
    round: written.round,
  });
  return {
    ok: true,
    handoffPath: written.handoffPath,
    metaPath: posted.metaPath,
    commentId: posted.commentId,
    round: written.round,
    prUrl: written.prUrl,
    model: written.model,
    runId: written.runId,
    resumed: written.resumed,
  };
}
