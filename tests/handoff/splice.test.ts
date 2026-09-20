// Last edited: 2026-09-20 16:10 CDT

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spliceHandoff } from "../../src/handoff/splice.ts";
import { HANDOFF_END, HANDOFF_START } from "../../src/handoff/types.ts";

const BODIES = resolve(import.meta.dir, "..", "fixtures", "pr_bodies");
const body = (name: string) => readFileSync(join(BODIES, `${name}.md`), "utf8");

const TEXT = "**TLDR:** New text.\n\n## Where to find it\n\nHere.";
const BLOCK = `${HANDOFF_START}\n${TEXT}\n${HANDOFF_END}`;
const CLOSES = "Closes https://linear.app/chessbuddy/issue/CB-12";

function between(text: string): string {
  const start = text.indexOf(HANDOFF_START) + HANDOFF_START.length;
  const end = text.indexOf(HANDOFF_END);
  return text.slice(start, end);
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function ok(result: ReturnType<typeof spliceHandoff>) {
  if (!result.ok) throw new Error(`splice failed: ${result.reason}`);
  return result;
}

describe("spliceHandoff", () => {
  test("fresh body: the placeholder line between the markers is replaced", () => {
    const r = ok(spliceHandoff(body("fresh"), TEXT));
    expect(r.action).toBe("replaced");
    expect(r.changed).toBe(true);
    expect(r.body).toBe(body("fresh").replace("_Filled in by the hand-off step._", TEXT));
    expect(r.body).toContain(`## Hand-off\n\n${BLOCK}\n\n${CLOSES}`);
  });

  test("legacy body: the bare placeholder under the heading gets wrapped", () => {
    const r = ok(spliceHandoff(body("legacy"), TEXT));
    expect(r.action).toBe("filled_placeholder");
    expect(r.body).toBe(body("legacy").replace("_Filled in by the hand-off step._", BLOCK));
    expect(count(r.body, "## Hand-off")).toBe(1);
  });

  test("posted body: only the inside changes, and a re-post of the same text is unchanged", () => {
    const first = ok(spliceHandoff(body("posted"), TEXT));
    expect(first.action).toBe("replaced");
    expect(first.body).not.toContain("Old round.");
    expect(between(first.body)).toBe(`\n${TEXT}\n`);
    const again = ok(spliceHandoff(first.body, TEXT));
    expect(again.changed).toBe(false);
    expect(again.body).toBe(first.body);
    expect(first.body.slice(first.body.indexOf(HANDOFF_END))).toBe(
      body("posted").slice(body("posted").indexOf(HANDOFF_END)),
    );
  });

  test("no heading: a Hand-off section is appended after everything, Closes included", () => {
    const r = ok(spliceHandoff(body("no_heading"), TEXT));
    expect(r.action).toBe("appended");
    expect(r.body.startsWith(body("no_heading"))).toBe(true);
    expect(r.body).toBe(`${body("no_heading")}\n## Hand-off\n\n${BLOCK}\n`);
  });

  test("heading without the placeholder: the block goes right under the heading, human text below", () => {
    const r = ok(spliceHandoff(body("heading_no_placeholder"), TEXT));
    expect(r.action).toBe("inserted_after_heading");
    expect(r.body).toBe(
      body("heading_no_placeholder").replace("## Hand-off\n", `## Hand-off\n\n${BLOCK}\n`),
    );
    expect(r.body).toContain("A human wrote this line and wants to keep it.");
  });
});

describe("spliceHandoff, edge cases", () => {
  test("two pairs: the first is replaced and the second deleted wholesale", () => {
    const r = ok(spliceHandoff(body("double"), TEXT));
    expect(r.action).toBe("replaced");
    expect(r.removedDuplicates).toBe(1);
    expect(count(r.body, HANDOFF_START)).toBe(1);
    expect(r.body).not.toContain("second copy");
    expect(r.body).toContain("Some text between.\n\n\nCloses");
    expect(r.body).toContain(CLOSES);
  });

  test("unbalanced markers are refused", () => {
    expect(spliceHandoff(body("unbalanced"), TEXT)).toEqual({
      ok: false,
      reason: "markers_unbalanced",
      detail: "1 start / 0 end markers",
    });
    const crossed = `${HANDOFF_END}\nx\n${HANDOFF_START}\n`;
    expect(spliceHandoff(crossed, TEXT).ok).toBe(false);
  });

  test("CRLF body: bytes outside the markers are identical and the inside uses CRLF", () => {
    const crlf = body("fresh").replace(/\n/g, "\r\n");
    const r = ok(spliceHandoff(crlf, TEXT));
    const [before, after] = [
      crlf.slice(0, crlf.indexOf(HANDOFF_START)),
      crlf.slice(crlf.indexOf(HANDOFF_END)),
    ];
    expect(r.body.startsWith(before)).toBe(true);
    expect(r.body.endsWith(after)).toBe(true);
    expect(between(r.body)).toBe(`\r\n${TEXT.replace(/\n/g, "\r\n")}\r\n`);
    expect(ok(spliceHandoff(r.body, TEXT)).changed).toBe(false);
  });

  test("every action leaves exactly one Hand-off heading and one marker pair", () => {
    for (const name of [
      "fresh",
      "legacy",
      "posted",
      "no_heading",
      "heading_no_placeholder",
      "double",
    ]) {
      const r = ok(spliceHandoff(body(name), TEXT));
      expect(count(r.body, "## Hand-off")).toBe(1);
      expect(count(r.body, HANDOFF_START)).toBe(1);
      expect(count(r.body, HANDOFF_END)).toBe(1);
      expect(r.body).toContain(CLOSES);
    }
  });

  test("custom markers are honoured", () => {
    const markers = { start: "<!-- a -->", end: "<!-- b -->" };
    const r = ok(spliceHandoff("x\n<!-- a -->\nold\n<!-- b -->\n", "new", markers));
    expect(r.body).toBe("x\n<!-- a -->\nnew\n<!-- b -->\n");
  });
});
