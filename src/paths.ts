// Last edited: 2026-09-19 23:20 CDT
// Every path Marshall writes to derives from one root: MARSHALL_HOME or ~/.marshall.
// Paths under the Claude daemon's home (CLAUDE_CONFIG_DIR or ~/.claude) are read-only for us.

import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Expand a leading `~` or `~/` to the current user's home directory. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Root of Marshall's state: `MARSHALL_HOME`, else `~/.marshall`. */
export function marshallHome(): string {
  const override = process.env.MARSHALL_HOME;
  return resolve(expandTilde(override && override.length > 0 ? override : "~/.marshall"));
}

export function dbPath(): string {
  return join(marshallHome(), "marshall.db");
}

export function logDir(): string {
  return join(marshallHome(), "logs");
}

export function logPath(): string {
  return join(logDir(), "marshall.log");
}

export function handoffDir(): string {
  return join(marshallHome(), "handoffs");
}

/** Where agent hooks append their JSON lines: one `<runId>.jsonl` per run. */
export function eventsDir(): string {
  return join(marshallHome(), "events");
}

/** Root of Claude Code's own state: `CLAUDE_CONFIG_DIR`, else `~/.claude`. Read-only for Marshall. */
export function claudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return resolve(expandTilde(override && override.length > 0 ? override : "~/.claude"));
}

/** `~/.claude/jobs/` — one directory per background job, each holding `state.json`. */
export function claudeJobsDir(): string {
  return join(claudeHome(), "jobs");
}

/**
 * The transcript Claude Code writes for a session: `~/.claude/projects/<slug>/<sessionId>.jsonl`,
 * where the slug is the cwd's real path (symlinks resolved, as Claude Code does) with every
 * non-alphanumeric character replaced by `-`.
 */
export function transcriptPath(cwd: string, sessionId: string): string {
  let real = resolve(cwd);
  try {
    real = realpathSync(real);
  } catch {
    // The directory is gone; the resolved path is the best remaining guess.
  }
  const slug = real.replace(/[^A-Za-z0-9]/g, "-");
  return join(claudeHome(), "projects", slug, `${sessionId}.jsonl`);
}

/** Create the state directory tree. Safe to call repeatedly (`mkdir -p` semantics). */
export function ensureHome(): string {
  const home = marshallHome();
  for (const dir of [home, logDir(), handoffDir(), eventsDir()]) {
    mkdirSync(dir, { recursive: true });
  }
  return home;
}
