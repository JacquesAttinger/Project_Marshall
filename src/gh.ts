// Last edited: 2026-09-20 15:35 CDT
// The one place that spawns `gh`. Mirrors src/git.ts: callers pass argv and get stdout back.
// Tests point MARSHALL_GH_BIN at tests/fixtures/fake-gh.

import { gitEnv } from "./git.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

export class GhError extends Error {
  override name = "GhError";
}

/** The binary to run: MARSHALL_GH_BIN, else `gh` on PATH. */
export function ghBin(): string {
  const override = process.env.MARSHALL_GH_BIN;
  return override && override.length > 0 ? override : "gh";
}

/**
 * Run `gh <args>` in `cwd` and return stdout untouched (no newline stripping: `pr view --json`
 * output is parsed, and a PR body must round-trip byte for byte). Non-zero exit → GhError.
 */
export async function runGh(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn([ghBin(), ...args], {
    cwd,
    env: gitEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, DEFAULT_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut)
      throw new GhError(`gh ${args.join(" ")} timed out after ${DEFAULT_TIMEOUT_MS} ms`);
    if (code !== 0) {
      throw new GhError(`gh ${args.join(" ")} exited ${code}: ${stderr.trim().slice(0, 500)}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
