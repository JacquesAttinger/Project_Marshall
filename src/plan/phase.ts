// Last edited: 2026-09-20 13:10 CDT
// runPlanPhase: classify → brief → launch the planner → wait → verify with git → check headings →
// post the summary to Linear. Each step is small; the phase reads top to bottom.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "../log.ts";
import { kill, launch, mintRunId, type Run } from "../runner/index.ts";
import { writeBrief } from "./brief.ts";
import { classifyIssue, modelFor } from "./classify.ts";
import { renderSummary } from "./summary.ts";
import { checkPlanFile, revisionNumbers } from "./template.ts";
import type { Classification, PlanFailure, PlanPhaseInput, PlanPhaseResult } from "./types.ts";
import { planFilesOnBranch, verifyPlanCommit } from "./verify.ts";
import { createRunWaiter } from "./wait.ts";

/** `<repo>/plugin`: what `--plugin-dir` receives so `/marshall:plan` resolves inside the agent. */
export const PLUGIN_DIR = resolve(import.meta.dir, "..", "..", "plugin");

const log = createLogger({ module: "plan" });

type Ctx = PlanPhaseInput & { mode: "fresh" | "revise"; base: string; runId: string };

function fail(ctx: Ctx, reason: PlanFailure, detail: string, briefPath?: string): PlanPhaseResult {
  log.warn("plan.failed", { issue: ctx.issue.identifier, runId: ctx.runId, reason, detail });
  return { ok: false, reason, detail, runId: ctx.runId, briefPath };
}

async function pickModel(
  ctx: Ctx,
): Promise<{ model: string; classification: Classification | null } | PlanPhaseResult> {
  if (ctx.model) return { model: ctx.model, classification: null };
  try {
    const classification = await classifyIssue(ctx.issue, { model: ctx.config.models.classifier });
    log.info("plan.classified", { issue: ctx.issue.identifier, ...classification });
    return { model: modelFor(classification, ctx.config), classification };
  } catch (err) {
    return fail(ctx, "classifier_failed", (err as Error).message);
  }
}

/**
 * Revise mode: the existing plan (given, or the one plan file on the branch) and the revision
 * number (given, or one more than the newest `## Revision N` already in the file).
 */
async function reviseInfo(ctx: Ctx): Promise<{ planPath?: string; revision?: number }> {
  if (ctx.mode === "fresh") return {};
  let planPath = ctx.planPath;
  if (!planPath) {
    const found = await planFilesOnBranch(ctx.cwd, ctx.base).catch(() => []);
    planPath = found.length === 1 ? found[0] : undefined;
  }
  let revision = ctx.revision;
  if (revision === undefined) {
    const full = planPath ? join(ctx.cwd, planPath) : null;
    const seen = full && existsSync(full) ? revisionNumbers(readFileSync(full, "utf8")) : [];
    revision = Math.max(0, ...seen) + 1;
  }
  return { planPath, revision };
}

async function launchPlanner(ctx: Ctx, model: string, briefPath: string): Promise<Run | Error> {
  try {
    return await launch(ctx.db, {
      runId: ctx.runId,
      name: `${ctx.issue.identifier} plan`,
      cwd: ctx.cwd,
      model,
      prompt: `/marshall:plan ${briefPath}`,
      extraArgs: ["--plugin-dir", PLUGIN_DIR],
    });
  } catch (err) {
    return err as Error;
  }
}

/** After the run: git says only the plan changed, the headings are all there, revise has its section. */
async function checkOutput(ctx: Ctx, briefPath: string): Promise<string | PlanPhaseResult> {
  const verified = await verifyPlanCommit({ cwd: ctx.cwd, base: ctx.base, mode: ctx.mode });
  if (!verified.ok) {
    const files = verified.files.length > 0 ? ` (${verified.files.join(", ")})` : "";
    return fail(
      ctx,
      "unexpected_changes",
      `${verified.reason}: ${verified.detail}${files}`,
      briefPath,
    );
  }
  const check = checkPlanFile(join(ctx.cwd, verified.planPath));
  const problems = [
    ...check.missing.map((s) => `missing "${s}"`),
    ...check.misordered.map((s) => `"${s}" out of order`),
  ];
  const revision = ctx.revision ?? 1;
  if (ctx.mode === "revise" && !check.revisions.includes(revision)) {
    problems.push(`missing "Revision ${revision}"`);
  }
  if (problems.length > 0) {
    return fail(ctx, "missing_sections", `${verified.planPath}: ${problems.join("; ")}`, briefPath);
  }
  return verified.planPath;
}

async function postSummary(ctx: Ctx, planPath: string): Promise<void> {
  const planText = readFileSync(join(ctx.cwd, planPath), "utf8");
  await ctx.linear.comment(
    ctx.issue.id,
    renderSummary({
      identifier: ctx.issue.identifier,
      branchName: ctx.issue.branchName,
      planPath,
      planText,
      mode: ctx.mode,
      revision: ctx.revision,
    }),
  );
}

/** Plan one issue end to end. Never throws for an agent's mistakes; only for a broken input. */
export async function runPlanPhase(input: PlanPhaseInput): Promise<PlanPhaseResult> {
  const ctx: Ctx = {
    ...input,
    mode: input.mode ?? "fresh",
    base: input.base ?? `origin/${input.config.baseBranch}`,
    runId: mintRunId(`${input.issue.identifier} plan`),
  };
  const picked = await pickModel(ctx);
  if ("ok" in picked) return picked;
  const revise = await reviseInfo(ctx);
  ctx.revision = revise.revision;
  const briefPath = writeBrief({
    runId: ctx.runId,
    issue: ctx.issue,
    mode: ctx.mode,
    revision: revise.revision,
    planPath: revise.planPath,
  });
  const ownWaiter = input.waiter ? null : createRunWaiter(input.db);
  const waiter = input.waiter ?? (ownWaiter as NonNullable<typeof ownWaiter>);
  try {
    const run = await launchPlanner(ctx, picked.model, briefPath);
    if (run instanceof Error) return fail(ctx, "launch_failed", run.message, briefPath);
    input.onLaunched?.(run);
    const terminal = await waiter.wait(ctx.runId, ctx.config.planMinutes * 60_000);
    if (!terminal) {
      await kill(input.db, ctx.runId);
      return fail(ctx, "timeout", `no Stop within ${ctx.config.planMinutes} min`, briefPath);
    }
    if (terminal.kind === "failed") return fail(ctx, "run_failed", terminal.error, briefPath);
    const planPath = await checkOutput(ctx, briefPath);
    if (typeof planPath !== "string") return planPath;
    await postSummary(ctx, planPath);
    log.info("plan.done", { issue: ctx.issue.identifier, runId: ctx.runId, planPath });
    return {
      ok: true,
      planPath,
      classification: picked.classification,
      model: picked.model,
      runId: ctx.runId,
      briefPath,
    };
  } finally {
    ownWaiter?.stop();
  }
}
