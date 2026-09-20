// Last edited: 2026-09-20 15:50 CDT

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HANDOFF_SECTIONS } from "../../src/handoff/types.ts";
import {
  checkHandoffFile,
  checkHandoffText,
  recipeFacts,
  roundOf,
  TEMPLATE_PATH,
} from "../../src/handoff/validate.ts";
import { headings } from "../../src/markdown.ts";

const FIXTURES = resolve(import.meta.dir, "..", "fixtures", "handoffs");
const fixture = (name: string) => join(FIXTURES, `${name}.md`);
const good = () => readFileSync(fixture("good"), "utf8");

const PR = "https://github.com/example/chessbuddy/pull/12";
const BRANCH = "cb-12-fix-castling-through-check";

describe("checkHandoffFile", () => {
  test("the good fixture passes and yields the PR URL and branch", () => {
    expect(checkHandoffFile(fixture("good"))).toEqual({
      ok: true,
      missing: [],
      misordered: [],
      round: null,
      prUrl: PR,
      branch: BRANCH,
      problems: [],
    });
  });

  test("expected PR URL and branch are enforced when given", () => {
    expect(checkHandoffFile(fixture("good"), { prUrl: PR, branch: BRANCH }).ok).toBe(true);
    const wrong = checkHandoffFile(fixture("good"), {
      prUrl: "https://github.com/example/chessbuddy/pull/13",
      branch: "other",
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.problems).toEqual([
      `"Verification recipe" names PR ${PR}, expected https://github.com/example/chessbuddy/pull/13`,
      `"Verification recipe" names branch ${BRANCH}, expected other`,
    ]);
  });

  test("missing sections are named, and the fact checks are skipped for absent sections", () => {
    const check = checkHandoffFile(fixture("missing_sections"));
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(["Orientation", "Verification recipe"]);
    expect(check.problems).toEqual(['missing "Orientation"', 'missing "Verification recipe"']);
    expect(check.prUrl).toBeNull();
  });

  test("no PR URL and no branch line in section 6 are two problems", () => {
    const check = checkHandoffFile(fixture("no_pr"));
    expect(check).toMatchObject({ ok: false, prUrl: null, branch: null });
    expect(check.problems).toEqual([
      '"Verification recipe" has no PR URL',
      '"Verification recipe" has no "- Branch:" line',
    ]);
  });
});

describe("checkHandoffFile, ordering and sub-lists", () => {
  test("a Round block right after the TLDR is fine and its number is read", () => {
    const check = checkHandoffFile(fixture("round2"));
    expect(check).toMatchObject({ ok: true, round: 2, problems: [] });
    expect(roundOf(good())).toBeNull();
  });

  test("a Round block after section 2 is a problem", () => {
    const check = checkHandoffFile(fixture("round_misplaced"));
    expect(check.ok).toBe(false);
    expect(check.round).toBe(2);
    expect(check.problems[0]).toContain(
      'must come right after the TLDR, before "Where to find it"',
    );
  });

  test("sections out of order are reported", () => {
    const check = checkHandoffFile(fixture("misordered"));
    expect(check.ok).toBe(false);
    // Orientation sits after "What was wrong and why", so the later required section is flagged.
    expect(check.misordered).toEqual(["What was wrong and why"]);
    expect(check.problems).toEqual(['"What was wrong and why" out of order']);
  });

  test("section 5 without the two bold sub-lists fails, naming each", () => {
    const check = checkHandoffFile(fixture("no_sublists"));
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual([
      '"What the agent did" lacks **Review notes (not fixed)**',
      '"What the agent did" lacks **Follow-ups proposed**',
    ]);
  });

  test("a missing file is one problem, not a throw", () => {
    const check = checkHandoffFile("/nope/CB-12.md");
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual(["file not found: /nope/CB-12.md"]);
    expect(check.missing).toEqual([...HANDOFF_SECTIONS]);
  });
});

describe("checkHandoffText details", () => {
  test("heading case and trailing punctuation do not matter; `## TLDR` counts", () => {
    const text = good()
      .replace("## What was wrong and why", "## What Was Wrong And Why:")
      .replace(/\*\*TLDR:\*\*[^\n]*\n[^\n]*\n/, "## TLDR\n\nHeading style.\n");
    expect(checkHandoffText(text).ok).toBe(true);
  });

  test("the bold labels may carry a colon inside the bold", () => {
    const text = good()
      .replace("**Review notes (not fixed)**", "**Review notes (not fixed):**")
      .replace("**Follow-ups proposed**", "**Follow-ups proposed:**");
    expect(checkHandoffText(text).ok).toBe(true);
  });

  test("recipeFacts reads several branch-line spellings and only section 6", () => {
    for (const line of [
      "- Branch: `x/y`",
      "- **Branch:** x/y",
      "- **Branch**: x/y",
      "Branch: x/y",
      "* branch: x/y",
    ]) {
      const text = good().replace("- Branch: `cb-12-fix-castling-through-check`", line);
      expect(recipeFacts(text).branch).toBe("x/y");
    }
    const prose = good().replace(
      "- Branch: `cb-12-fix-castling-through-check`",
      "Branch off main first.",
    );
    expect(recipeFacts(prose).branch).toBeNull();
    // A PR URL outside section 6 does not count.
    const moved = good()
      .replace(`- PR: ${PR}\n`, "")
      .replace("## Where to find it", `PR: ${PR}\n\n## Where to find it`);
    expect(recipeFacts(moved).prUrl).toBeNull();
  });

  test("the template's H2 list is HANDOFF_SECTIONS minus the TLDR paragraph", () => {
    const template = readFileSync(TEMPLATE_PATH, "utf8");
    expect(headings(template)).toEqual(HANDOFF_SECTIONS.slice(1));
    // The template carries the labels and the recipe lines the writer must keep.
    expect(template).toContain("**Review notes (not fixed)**");
    expect(template).toContain("**Follow-ups proposed**");
    for (const line of ["- Branch:", "- PR:", "- Setup:", "- Steps:", "- Expected:"]) {
      expect(template).toContain(line);
    }
  });
});
