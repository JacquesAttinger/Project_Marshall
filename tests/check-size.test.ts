// Last edited: 2026-09-19 21:28 CDT

import { describe, expect, test } from "bun:test";
import {
  checkSource,
  formatViolation,
  MAX_FILE_LINES,
  MAX_FUNCTION_LINES,
} from "../scripts/check-size.ts";

/** Build a function whose body pads it out to exactly `total` lines. */
function fn(name: string, total: number, kind: "decl" | "arrow" | "method" = "decl"): string {
  const body = Array.from({ length: total - 2 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  if (kind === "arrow") return `const ${name} = () => {\n${body}\n};`;
  if (kind === "method") return `class C {\n${name}() {\n${body}\n}\n}`;
  return `function ${name}() {\n${body}\n}`;
}

describe("checkSource", () => {
  test("an 80-line function fails", () => {
    const violations = checkSource("x.ts", fn("big", 80));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.name).toBe("big");
    expect(violations[0]?.lines).toBe(80);
    expect(violations[0]?.limit).toBe(MAX_FUNCTION_LINES);
    expect(formatViolation(violations[0] as NonNullable<(typeof violations)[0]>)).toBe(
      "x.ts:1 big 80 > 75",
    );
  });

  test("a 70-line function passes", () => {
    expect(checkSource("x.ts", fn("ok", 70))).toHaveLength(0);
  });

  test("exactly 75 lines passes, 76 fails", () => {
    expect(checkSource("x.ts", fn("edge", 75))).toHaveLength(0);
    expect(checkSource("x.ts", fn("edge", 76))).toHaveLength(1);
  });

  test("arrow functions and methods are checked and named", () => {
    const arrow = checkSource("a.ts", fn("arrowFn", 80, "arrow"));
    expect(arrow[0]?.name).toBe("arrowFn");
    const method = checkSource("m.ts", fn("methodFn", 80, "method"));
    expect(method[0]?.name).toBe("methodFn");
  });

  test("a file over 500 lines fails on the file", () => {
    const source = Array.from({ length: MAX_FILE_LINES + 1 }, (_, i) => `// ${i}`).join("\n");
    const violations = checkSource("long.ts", source);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.name).toBe("<file>");
    expect(violations[0]?.lines).toBe(MAX_FILE_LINES + 1);
  });

  test("a file at exactly 500 lines passes", () => {
    const source = Array.from({ length: MAX_FILE_LINES }, (_, i) => `// ${i}`).join("\n");
    expect(checkSource("ok.ts", source)).toHaveLength(0);
  });
});
