// Last edited: 2026-09-20 11:00 CDT

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  checkPlanFile,
  checkPlanText,
  headings,
  isPlanPath,
  REQUIRED_SECTIONS,
  revisionNumbers,
  sectionBody,
  TEMPLATE_PATH,
  tldrOf,
} from "../../src/plan/template.ts";

const PLANS = resolve(import.meta.dir, "..", "fixtures", "plans");
const good = () => readFileSync(join(PLANS, "good_plan.md"), "utf8");

describe("checkPlanText", () => {
  test("the fixture and the template both pass", () => {
    expect(checkPlanFile(join(PLANS, "good_plan.md"))).toEqual({
      ok: true,
      missing: [],
      misordered: [],
      revisions: [],
    });
    expect(checkPlanFile(TEMPLATE_PATH).ok).toBe(true);
  });

  test("the template's H2 list is REQUIRED_SECTIONS minus the TLDR paragraph", () => {
    expect(headings(readFileSync(TEMPLATE_PATH, "utf8"))).toEqual(REQUIRED_SECTIONS.slice(1));
  });

  test("missing sections are named", () => {
    const check = checkPlanFile(join(PLANS, "missing_plan.md"));
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(["Likely touched files", "Out of scope found"]);
    expect(check.misordered).toEqual([]);
  });

  test("a section out of order is reported, and `## TLDR` counts as the TLDR", () => {
    const check = checkPlanFile(join(PLANS, "reordered_plan.md"));
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual([]);
    expect(check.misordered).toEqual(["Orientation"]);
  });

  test("heading case and trailing punctuation do not matter", () => {
    const text = good().replace("## What is wrong and why", "## What Is Wrong And Why:");
    expect(checkPlanText(text).ok).toBe(true);
  });

  test("no TLDR paragraph and no TLDR heading → missing", () => {
    const text = good().replace(/\*\*TLDR:\*\*[^\n]*\n[^\n]*\n[^\n]*\n/, "");
    expect(checkPlanText(text).missing).toEqual(["TLDR"]);
  });

  test("a TLDR paragraph after the first H2 does not count", () => {
    const text = `${good().replace(/\*\*TLDR:\*\*/, "TLDR gone.")}\n**TLDR:** too late\n`;
    expect(checkPlanText(text).missing).toEqual(["TLDR"]);
  });

  test("revision headings are collected in order", () => {
    const text = `${good()}\n## Revision 1\n\nx\n\n## Revision 2\n\ny\n`;
    expect(checkPlanText(text)).toMatchObject({ ok: true, revisions: [1, 2] });
    expect(revisionNumbers(good())).toEqual([]);
  });
});

describe("sectionBody / tldrOf", () => {
  test("returns the body between H2s and null when absent", () => {
    expect(sectionBody(good(), "Decisions made alone")).toBe(
      "- Kept the fix in `castlingMoves()` rather than a new helper: one condition does not need one.",
    );
    expect(sectionBody(good(), "Verification")).toBe(
      "`bun test tests/engine/moves.test.ts` passes with the new case.",
    );
    expect(sectionBody(good(), "Nope")).toBeNull();
  });

  test("tldrOf returns the paragraph form, else the heading form, else null", () => {
    expect(tldrOf(good())).toBe(
      "**TLDR:** The king can castle while a square it crosses is attacked.\nThe move generator skips the attack check for the middle square.\nOne condition fixes it.",
    );
    const reordered = readFileSync(join(PLANS, "reordered_plan.md"), "utf8");
    expect(tldrOf(reordered)).toBe("Heading form of the TLDR.");
    expect(tldrOf("# T\n\n## Plan\n\nx\n")).toBeNull();
  });
});

describe("isPlanPath", () => {
  test("accepts docs/<topic>_plan.md only", () => {
    expect(isPlanPath("docs/fix-castling_plan.md")).toBe(true);
    expect(isPlanPath("docs/m0_bootstrap_plan.md")).toBe(true);
    expect(isPlanPath("docs/steps/04_plan.md")).toBe(false);
    expect(isPlanPath("docs/notes.md")).toBe(false);
    expect(isPlanPath("src/x_plan.md")).toBe(false);
  });
});
