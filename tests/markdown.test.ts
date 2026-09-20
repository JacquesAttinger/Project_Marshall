// Last edited: 2026-09-20 15:20 CDT

import { describe, expect, test } from "bun:test";
import {
  checkRequiredSections,
  hasTldrParagraph,
  headings,
  normalizeHeading,
  sectionBody,
  tldrOf,
} from "../src/markdown.ts";

const REQUIRED = ["TLDR", "Alpha", "Beta", "Gamma"] as const;

const doc = `# Title

<!-- Last edited: now -->

**TLDR:** Short one.
Second line of the TLDR.

## Alpha

alpha body

## Beta

beta body
more beta

## Gamma

gamma body
`;

describe("checkRequiredSections", () => {
  test("a document with every section in order passes", () => {
    expect(checkRequiredSections(doc, REQUIRED)).toEqual({ missing: [], misordered: [] });
  });

  test("missing sections are named in the required order", () => {
    const text = doc.replace("## Beta", "## Other");
    expect(checkRequiredSections(text, REQUIRED)).toEqual({ missing: ["Beta"], misordered: [] });
  });

  test("a section before one that should precede it is misordered", () => {
    const text = `${doc.replace(/## Gamma\n\ngamma body\n/, "")}`.replace(
      "## Alpha",
      "## Gamma\n\ngamma body\n\n## Alpha",
    );
    expect(checkRequiredSections(text, REQUIRED)).toEqual({
      missing: [],
      misordered: ["Gamma"],
    });
  });

  test("extra headings do not matter", () => {
    const text = doc.replace("## Beta", "## Extra\n\nx\n\n## Beta");
    expect(checkRequiredSections(text, REQUIRED)).toEqual({ missing: [], misordered: [] });
  });

  test("heading case, trailing punctuation, and inner whitespace are ignored", () => {
    expect(normalizeHeading("  What  Is Wrong And Why:. ")).toBe("what is wrong and why");
    const text = doc.replace("## Beta", "## BETA:");
    expect(checkRequiredSections(text, REQUIRED).missing).toEqual([]);
  });
});

describe("TLDR paragraph", () => {
  test("counts before the first H2, not after", () => {
    expect(hasTldrParagraph(doc)).toBe(true);
    const late = `${doc.replace("**TLDR:**", "TLDR gone.")}\n**TLDR:** too late\n`;
    expect(hasTldrParagraph(late)).toBe(false);
    expect(checkRequiredSections(late, REQUIRED).missing).toEqual(["TLDR"]);
  });

  test("a `## TLDR` heading also satisfies the requirement", () => {
    const text = doc.replace("**TLDR:** Short one.\nSecond line of the TLDR.", "## TLDR\n\nbody");
    expect(hasTldrParagraph(text)).toBe(false);
    expect(checkRequiredSections(text, REQUIRED)).toEqual({ missing: [], misordered: [] });
  });
});

describe("headings / sectionBody / tldrOf", () => {
  test("headings lists H2 titles in order, untouched", () => {
    expect(headings(doc)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(headings("### not h2\n# h1\n")).toEqual([]);
  });

  test("sectionBody returns the body up to the next H2, the last section to the end, null when absent", () => {
    expect(sectionBody(doc, "Beta")).toBe("beta body\nmore beta");
    expect(sectionBody(doc, "gamma:")).toBe("gamma body");
    expect(sectionBody(doc, "Nope")).toBeNull();
  });

  test("tldrOf returns the paragraph block, or the `## TLDR` body, or null", () => {
    expect(tldrOf(doc)).toBe("**TLDR:** Short one.\nSecond line of the TLDR.");
    const heading = doc.replace(
      "**TLDR:** Short one.\nSecond line of the TLDR.",
      "## TLDR\n\nheading style",
    );
    expect(tldrOf(heading)).toBe("heading style");
    expect(tldrOf("# only a title\n")).toBeNull();
  });
});
