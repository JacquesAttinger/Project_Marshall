// Last edited: 2026-09-20 15:20 CDT
// The plan file's required sections and the heading check that enforces them. The text helpers
// live in src/markdown.ts (shared with the hand-off check) and are re-exported here so existing
// callers keep their import. The template the agent copies is plugin/skills/plan/template.md.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkRequiredSections, headings } from "../markdown.ts";

export { hasTldrParagraph, headings, sectionBody, tldrOf } from "../markdown.ts";

export const TEMPLATE_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "plugin",
  "skills",
  "plan",
  "template.md",
);

/** H2 headings, in this order. `TLDR` is also satisfied by a `**TLDR:**` paragraph under the H1. */
export const REQUIRED_SECTIONS = [
  "TLDR",
  "Where to find it",
  "Orientation",
  "What is wrong and why",
  "Likely touched files",
  "Plan",
  "Decisions made alone",
  "Out of scope found",
  "Verification",
] as const;

/** `docs/<topic>_plan.md`, one level deep, kebab or snake topic. */
export const PLAN_PATH_PATTERN = /^docs\/[a-z0-9][a-z0-9_-]*_plan\.md$/;

export function isPlanPath(path: string): boolean {
  return PLAN_PATH_PATTERN.test(path);
}

export interface PlanCheck {
  ok: boolean;
  missing: string[];
  /** Required sections that appear before one that should precede them. */
  misordered: string[];
  /** `## Revision N` headings, in file order. */
  revisions: number[];
}

export function revisionNumbers(text: string): number[] {
  return headings(text)
    .map((h) => /^revision\s+(\d+)$/i.exec(h.trim())?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
}

export function checkPlanText(text: string): PlanCheck {
  const { missing, misordered } = checkRequiredSections(text, REQUIRED_SECTIONS);
  return {
    ok: missing.length === 0 && misordered.length === 0,
    missing,
    misordered,
    revisions: revisionNumbers(text),
  };
}

export function checkPlanFile(path: string): PlanCheck {
  return checkPlanText(readFileSync(path, "utf8"));
}
