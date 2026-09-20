// Last edited: 2026-09-20 16:10 CDT

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderPackage } from "../../src/handoff/render.ts";
import { headings, tldrOf } from "../../src/markdown.ts";

const good = () =>
  readFileSync(resolve(import.meta.dir, "..", "fixtures", "handoffs", "good.md"), "utf8");

describe("renderPackage", () => {
  test("strips the H1 and the Last-edited stamp, keeps every section", () => {
    const out = renderPackage(good());
    expect(out.startsWith("**TLDR:** The king could castle")).toBe(true);
    expect(out).not.toContain("# CB-12 — Fix castling through check\n");
    expect(out).not.toContain("Last edited");
    expect(headings(out)).toEqual(headings(good()));
    expect(out.endsWith("PASS when step 2 shows no castling move in the move list.")).toBe(true);
  });

  test("no badge → the body is the file minus the two stripped lines", () => {
    const expected = good()
      .replace("# CB-12 — Fix castling through check\n", "")
      .replace("<!-- Last edited: 2026-09-20 15:00 CDT -->\n", "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    expect(renderPackage(good())).toBe(expected);
  });

  test("a badge lands right under the TLDR paragraph", () => {
    const out = renderPackage(good(), { badge: "rebased after https://github.com/x/y/pull/1" });
    const tldr = tldrOf(good()) as string;
    expect(out).toContain(
      `${tldr}\n\n_rebased after https://github.com/x/y/pull/1_\n\n## Where to find it`,
    );
  });

  test("a badge lands under a `## TLDR` section too", () => {
    const text = good().replace(
      /\*\*TLDR:\*\*[^\n]*\n[^\n]*\n/,
      "## TLDR\n\nHeading style.\nSecond line.\n",
    );
    const out = renderPackage(text, { badge: "badge" });
    expect(out).toContain(
      "## TLDR\n\nHeading style.\nSecond line.\n\n_badge_\n\n## Where to find it",
    );
  });

  test("CRLF input is normalised", () => {
    expect(renderPackage(good().replace(/\n/g, "\r\n"))).toBe(renderPackage(good()));
  });
});
