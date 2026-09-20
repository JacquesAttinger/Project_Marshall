// Last edited: 2026-09-20 15:50 CDT
// `marshall handoff check <file> [--json]`: the hand-off shape check alone, for a file the writer
// produced or a human edited. Exit 0 when it is valid, 1 with one problem per line otherwise.

import { resolve } from "node:path";
import { checkHandoffFile } from "../handoff/validate.ts";
import { expandTilde } from "../paths.ts";

export function runHandoffCheck(file: string, json: boolean): number {
  const path = resolve(expandTilde(file));
  const check = checkHandoffFile(path);
  if (json) {
    console.log(JSON.stringify({ path, ...check }, null, 2));
  } else if (check.ok) {
    console.log(`OK: ${path} is a valid hand-off (PR ${check.prUrl}, branch ${check.branch})`);
  } else {
    for (const problem of check.problems) console.log(problem);
  }
  return check.ok ? 0 : 1;
}
