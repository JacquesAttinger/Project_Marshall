// Last edited: 2026-09-19 22:55 CDT
// The one place that spawns the `claude` binary. Tests point MARSHALL_CLAUDE_BIN at a shim.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { RunnerError } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Env vars that mark "inside a Claude session". Stripped so a nested launch is not refused. */
const STRIP_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

/**
 * The binary to run: MARSHALL_CLAUDE_BIN, else the first `claude` on PATH outside cmux's shim
 * directory. The cmux shim rewrites `claude stop <id>` into a prompt, so it must be skipped.
 */
export function claudeBin(): string {
  const override = process.env.MARSHALL_CLAUDE_BIN;
  if (override && override.length > 0) return override;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0 || dir.includes("cmux-cli-shims")) continue;
    const candidate = join(dir, "claude");
    if (existsSync(candidate)) return candidate;
  }
  return "claude";
}

function spawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !STRIP_ENV.includes(k)) env[k] = v;
  }
  return env;
}

export interface RunClaudeOpts {
  cwd?: string;
  timeoutMs?: number;
}

/** Run `claude <args>` to completion and return stdout. Non-zero exit or timeout → RunnerError. */
export async function runClaude(args: string[], opts: RunClaudeOpts = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proc = Bun.spawn([claudeBin(), ...args], {
    cwd: opts.cwd,
    env: spawnEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      throw new RunnerError(`claude ${args[0] ?? ""} timed out after ${timeoutMs} ms`);
    }
    if (code !== 0) {
      const detail = (stderr.trim() || stdout.trim()).slice(0, 500);
      throw new RunnerError(`claude ${args[0] ?? ""} exited ${code}: ${detail}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
