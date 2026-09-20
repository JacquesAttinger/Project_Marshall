// Last edited: 2026-09-20 11:00 CDT
// The plan file's required sections and the heading check that enforces them. Pure text functions,
// so the tests pass strings. The template the agent copies is skills/plan/template.md.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const TEMPLATE_PATH = resolve(import.meta.dir, "..", "..", "skills", "plan", "template.md");

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

function normalize(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[.:]+$/, "")
    .replace(/\s+/g, " ");
}

/** H2 titles in file order, untouched. */
export function headings(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** A `**TLDR:**` paragraph before the first H2 counts as the TLDR section. */
export function hasTldrParagraph(text: string): boolean {
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line)) return false;
    if (/^\*\*TLDR:?\*\*:?/i.test(line.trim())) return true;
  }
  return false;
}

export function revisionNumbers(text: string): number[] {
  return headings(text)
    .map((h) => /^revision\s+(\d+)$/i.exec(h.trim())?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
}

export function checkPlanText(text: string): PlanCheck {
  const found = headings(text).map(normalize);
  if (hasTldrParagraph(text)) found.unshift("tldr");
  const missing: string[] = [];
  const misordered: string[] = [];
  let furthest = -1;
  for (const section of REQUIRED_SECTIONS) {
    const at = found.indexOf(normalize(section));
    if (at < 0) {
      missing.push(section);
      continue;
    }
    if (at < furthest) misordered.push(section);
    furthest = Math.max(furthest, at);
  }
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

/** Body of `## <heading>` up to the next H2, trimmed. Null when the section is absent. */
export function sectionBody(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const want = normalize(heading);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i] as string);
    if (!m?.[1]) continue;
    if (start >= 0) return lines.slice(start, i).join("\n").trim();
    if (normalize(m[1]) === want) start = i + 1;
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() : null;
}

/** The TLDR paragraph (the `**TLDR:**` block, or the `## TLDR` body), or null. */
export function tldrOf(text: string): string | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (/^##\s/.test(line)) break;
    if (!/^\*\*TLDR:?\*\*:?/i.test(line)) continue;
    const block: string[] = [];
    for (let j = i; j < lines.length && (lines[j] as string).trim().length > 0; j++) {
      block.push((lines[j] as string).trim());
    }
    return block.join("\n");
  }
  return sectionBody(text, "TLDR");
}
