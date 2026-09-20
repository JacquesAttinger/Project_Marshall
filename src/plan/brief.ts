// Last edited: 2026-09-20 11:10 CDT
// Renders an IssueDetail to the Markdown brief a planner agent reads. The brief is the agent's only
// source for the issue: facts only, no instructions (those live in skills/plan/SKILL.md).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueComment, IssueDetail } from "../linear/index.ts";
import { briefsDir } from "../paths.ts";
import type { PlanMode } from "./types.ts";

/** Linear's priority integers, as words. */
const PRIORITY_WORDS: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export function priorityWord(priority: number): string {
  return PRIORITY_WORDS[priority] ?? `Unknown (${priority})`;
}

export interface BriefInput {
  runId: string;
  issue: IssueDetail;
  mode: PlanMode;
  /** Revise mode only. */
  revision?: number;
  /** Revise mode only: the existing plan, relative to the worktree. */
  planPath?: string;
  /** Override for tests. Default: now. */
  writtenAt?: string;
}

function renderComment(c: IssueComment): string {
  const who = c.fromMarshall ? "Marshall" : "You";
  return `### ${who} — ${c.createdAt}\n\n${c.body.trim()}`;
}

function renderRevision(input: BriefInput): string[] {
  const { issue } = input;
  const latest = issue.latestHumanComment;
  return [
    "## Revision",
    "",
    `- Number: ${input.revision ?? 1}`,
    `- Existing plan: ${input.planPath ?? "(unknown; find docs/*_plan.md on this branch)"}`,
    "",
    "### Latest comment from you",
    "",
    latest ? `${latest.createdAt}\n\n${latest.body.trim()}` : "(no human comment on the issue)",
    "",
  ];
}

/** The brief as Markdown. Pure, so the tests snapshot it. */
export function renderBrief(input: BriefInput): string {
  const { issue } = input;
  const lines = [
    `# ${issue.identifier} — ${issue.title}`,
    "",
    `<!-- Brief written by Marshall at ${input.writtenAt ?? new Date().toISOString()} for run ${input.runId} -->`,
    "",
    "## Issue",
    "",
    `- Identifier: ${issue.identifier}`,
    `- Title: ${issue.title}`,
    `- URL: ${issue.url}`,
    `- Priority: ${priorityWord(issue.priority)}`,
    `- Labels: ${issue.labels.length > 0 ? issue.labels.join(", ") : "(none)"}`,
    `- Branch: ${issue.branchName}`,
    "",
    "## Description",
    "",
    issue.description?.trim() || "(no description)",
    "",
    "## Comments",
    "",
    ...(issue.comments.length > 0
      ? issue.comments.flatMap((c) => [renderComment(c), ""])
      : ["(none)", ""]),
  ];
  if (input.mode === "revise") lines.push(...renderRevision(input));
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Path of the brief for a run: `<MARSHALL_HOME>/briefs/<runId>.md`. */
export function briefPath(runId: string): string {
  return join(briefsDir(), `${runId}.md`);
}

/** Write the brief and return its path. */
export function writeBrief(input: BriefInput): string {
  mkdirSync(briefsDir(), { recursive: true });
  const path = briefPath(input.runId);
  writeFileSync(path, renderBrief(input));
  return path;
}
