// Last edited: 2026-09-20 12:10 CDT
// The Linear comment the orchestrator posts after a plan lands: TLDR, decisions, where to look.
// LinearClient.comment appends the Marshall footer, so it is not added here.

import { sectionBody, tldrOf } from "./template.ts";
import type { PlanMode } from "./types.ts";

export interface SummaryInput {
  identifier: string;
  branchName: string;
  planPath: string;
  planText: string;
  mode: PlanMode;
  revision?: number;
}

export function renderSummary(input: SummaryInput): string {
  const title =
    input.mode === "revise"
      ? `**Plan revision ${input.revision ?? 1} for ${input.identifier}**`
      : `**Plan for ${input.identifier}**`;
  const decisions = sectionBody(input.planText, "Decisions made alone");
  const revision =
    input.mode === "revise" ? sectionBody(input.planText, `Revision ${input.revision ?? 1}`) : null;
  const parts = [
    `${title} — \`${input.planPath}\` on \`${input.branchName}\``,
    "",
    tldrOf(input.planText) ?? "(no TLDR)",
  ];
  if (revision) parts.push("", "**What changed**", "", revision);
  parts.push("", "**Decisions made alone**", "", decisions?.trim() || "(none)");
  return parts.join("\n");
}
