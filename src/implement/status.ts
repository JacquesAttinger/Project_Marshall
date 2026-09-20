// Last edited: 2026-09-20 10:45 CDT
// The contract between `/marshall:implement` and the orchestrator: one JSON file per issue at
// `<MARSHALL_HOME>/issues/<ISSUE-ID>/implement.json`, rewritten by the skill at each transition.
// Steps 06, 07, 08 import the schema from here; the skill's SKILL.md quotes the same shape.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { issueDir } from "../paths.ts";

export const IMPLEMENT_STATUS_FILE = "implement.json";

export const IMPLEMENT_PHASES = [
  "starting",
  "implementing",
  "testing",
  "pr_open",
  "reviewing",
  "fixing",
  "done",
] as const;

export const IMPLEMENT_OUTCOMES = ["pr_green", "review_exhausted", "tests_red", "blocked"] as const;

export const FollowupSchema = z.object({ title: z.string().min(1), body: z.string() }).strict();

export const ImplementStatusSchema = z
  .object({
    issueId: z.string().min(1),
    slot: z.number().int().min(0),
    phase: z.enum(IMPLEMENT_PHASES),
    /** 0 before the first review, then 1..maxCycles. */
    cycle: z.number().int().min(0),
    maxCycles: z.number().int().min(1),
    branch: z.string().min(1).nullable(),
    prUrl: z.string().url().nullable(),
    prDraft: z.boolean(),
    ciState: z.enum(["pending", "green", "red"]).nullable(),
    /** Non-null once the run has ended, whatever `phase` says. */
    outcome: z.enum(IMPLEMENT_OUTCOMES).nullable(),
    /** One line; set with tests_red, review_exhausted, and blocked. */
    reason: z.string().nullable(),
    followups: z.array(FollowupSchema),
    /** PLAUSIBLE review findings left as-is, one line each. */
    reviewNotes: z.array(z.string()),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ImplementStatus = z.infer<typeof ImplementStatusSchema>;
export type ImplementPhase = ImplementStatus["phase"];
export type ImplementOutcome = NonNullable<ImplementStatus["outcome"]>;

export class ImplementStatusError extends Error {
  override name = "ImplementStatusError";
}

/** `<MARSHALL_HOME>/issues/<ISSUE-ID>/implement.json`. */
export function implementStatusPath(issueId: string): string {
  return join(issueDir(issueId), IMPLEMENT_STATUS_FILE);
}

/** Validate an already-parsed object. Throws ImplementStatusError naming the failing key. */
export function parseImplementStatus(raw: unknown, source = "<inline>"): ImplementStatus {
  const result = ImplementStatusSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ImplementStatusError(`Invalid implement.json at ${source}: ${issues}`);
  }
  return result.data;
}

/** The parsed file, or null when the skill has not written one yet. A malformed file throws. */
export function readImplementStatus(issueId: string): ImplementStatus | null {
  const path = implementStatusPath(issueId);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ImplementStatusError(
      `implement.json is not valid JSON: ${path} (${(err as Error).message})`,
    );
  }
  return parseImplementStatus(raw, path);
}

/** True once the skill has written a final outcome. */
export function isImplementFinished(status: ImplementStatus): boolean {
  return status.outcome !== null;
}
