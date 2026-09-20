// Last edited: 2026-09-19 21:28 CDT
// Enforce the global size policy: 500 lines per file, 75 lines per function.
// Usage: bun scripts/check-size.ts [file...]   (no args = every .ts under src, scripts, tests, bin)

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";

export const MAX_FILE_LINES = 500;
export const MAX_FUNCTION_LINES = 75;

export interface SizeViolation {
  file: string;
  line: number;
  name: string;
  lines: number;
  limit: number;
}

type FunctionLike = ts.FunctionLikeDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

function functionName(node: FunctionLike): string {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return "<anonymous>";
}

/** Check one file's source text. Pure: no I/O, so tests can pass fixture strings. */
export function checkSource(file: string, source: string): SizeViolation[] {
  const violations: SizeViolation[] = [];
  const totalLines = source.split("\n").length;
  if (totalLines > MAX_FILE_LINES) {
    violations.push({ file, line: 1, name: "<file>", lines: totalLines, limit: MAX_FILE_LINES });
  }
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && node.body) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const end = sf.getLineAndCharacterOfPosition(node.end).line;
      const lines = end - start + 1;
      if (lines > MAX_FUNCTION_LINES) {
        violations.push({
          file,
          line: start + 1,
          name: functionName(node),
          lines,
          limit: MAX_FUNCTION_LINES,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

export function formatViolation(v: SizeViolation): string {
  return `${v.file}:${v.line} ${v.name} ${v.lines} > ${v.limit}`;
}

async function defaultFiles(): Promise<string[]> {
  const glob = new Bun.Glob("{src,scripts,tests,bin}/**/*.ts");
  return Array.from(glob.scanSync({ cwd: process.cwd() })).sort();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a.endsWith(".ts"));
  const files = args.length > 0 ? args : await defaultFiles();
  const violations = files.flatMap((f) =>
    checkSource(relative(process.cwd(), f), readFileSync(f, "utf8")),
  );
  for (const v of violations) console.error(formatViolation(v));
  process.exit(violations.length > 0 ? 1 : 0);
}

if (import.meta.main) await main();
