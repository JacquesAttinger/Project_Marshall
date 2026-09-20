// Last edited: 2026-09-20 15:45 CDT
// The hand-off file's shape check: six H2s in order, the optional Round block before section 2,
// the two bold sub-lists in section 5, and a PR URL plus a branch line in section 6. Pure text
// functions, so the tests pass strings; `problems` is what the resume nudge and the CLI print.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkRequiredSections, headings, normalizeHeading, sectionBody } from "../markdown.ts";
import {
  BRANCH_LINE,
  FOLLOWUPS_LABEL,
  HANDOFF_SECTIONS,
  type HandoffCheck,
  PR_URL_PATTERN,
  REVIEW_NOTES_LABEL,
  ROUND_HEADING,
} from "./types.ts";

/** The template the writer skill copies. Lives in the plugin because the agent runs elsewhere. */
export const TEMPLATE_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "plugin",
  "skills",
  "handoff",
  "template.md",
);

export interface Expected {
  prUrl?: string;
  branch?: string;
}

/** N from the first `## Round N — what changed` heading, or null. */
export function roundOf(text: string): number | null {
  for (const h of headings(text)) {
    const m = ROUND_HEADING.exec(normalizeHeading(h));
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

/** The PR URL and branch named in section 6, or nulls when the section or the facts are absent. */
export function recipeFacts(text: string): { prUrl: string | null; branch: string | null } {
  const recipe = sectionBody(text, "Verification recipe");
  if (recipe === null) return { prUrl: null, branch: null };
  return {
    prUrl: PR_URL_PATTERN.exec(recipe)?.[0] ?? null,
    branch: BRANCH_LINE.exec(recipe)?.[1] ?? null,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `**Label**` or `**Label:**`, any case, anywhere in the body. */
function hasBoldLabel(body: string, label: string): boolean {
  return new RegExp(`\\*\\*${escapeRegex(label)}:?\\*\\*`, "i").test(body);
}

function roundProblems(text: string): string[] {
  const found = headings(text).map(normalizeHeading);
  const roundAt = found.findIndex((h) => ROUND_HEADING.test(h));
  const whereAt = found.indexOf(normalizeHeading(HANDOFF_SECTIONS[1]));
  if (roundAt >= 0 && whereAt >= 0 && roundAt > whereAt) {
    return [
      `"Round N — what changed" must come right after the TLDR, before "${HANDOFF_SECTIONS[1]}"`,
    ];
  }
  return [];
}

function factProblems(
  facts: { prUrl: string | null; branch: string | null },
  expected: Expected,
): string[] {
  const section = `"${HANDOFF_SECTIONS[5]}"`;
  const problems: string[] = [];
  if (!facts.prUrl) problems.push(`${section} has no PR URL`);
  else if (expected.prUrl && facts.prUrl !== expected.prUrl) {
    problems.push(`${section} names PR ${facts.prUrl}, expected ${expected.prUrl}`);
  }
  if (!facts.branch) problems.push(`${section} has no "- Branch:" line`);
  else if (expected.branch && facts.branch !== expected.branch) {
    problems.push(`${section} names branch ${facts.branch}, expected ${expected.branch}`);
  }
  return problems;
}

export function checkHandoffText(text: string, expected: Expected = {}): HandoffCheck {
  const { missing, misordered } = checkRequiredSections(text, HANDOFF_SECTIONS);
  const problems = [
    ...missing.map((s) => `missing "${s}"`),
    ...misordered.map((s) => `"${s}" out of order`),
    ...roundProblems(text),
  ];
  const did = sectionBody(text, HANDOFF_SECTIONS[4]);
  if (did !== null) {
    for (const label of [REVIEW_NOTES_LABEL, FOLLOWUPS_LABEL]) {
      if (!hasBoldLabel(did, label)) problems.push(`"${HANDOFF_SECTIONS[4]}" lacks **${label}**`);
    }
  }
  const facts = recipeFacts(text);
  if (sectionBody(text, HANDOFF_SECTIONS[5]) !== null)
    problems.push(...factProblems(facts, expected));
  return {
    ok: problems.length === 0,
    missing,
    misordered,
    round: roundOf(text),
    prUrl: facts.prUrl,
    branch: facts.branch,
    problems,
  };
}

/** A missing file is one problem, not a throw: the writer may have produced nothing. */
export function checkHandoffFile(path: string, expected: Expected = {}): HandoffCheck {
  if (!existsSync(path)) {
    return {
      ok: false,
      missing: [...HANDOFF_SECTIONS],
      misordered: [],
      round: null,
      prUrl: null,
      branch: null,
      problems: [`file not found: ${path}`],
    };
  }
  return checkHandoffText(readFileSync(path, "utf8"), expected);
}
