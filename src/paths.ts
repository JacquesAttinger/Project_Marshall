// Last edited: 2026-09-19 21:28 CDT
// Every path Marshall writes to derives from one root: MARSHALL_HOME or ~/.marshall.

import { mkdirSync } from "node:fs";
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

/** Create the state directory tree. Safe to call repeatedly (`mkdir -p` semantics). */
export function ensureHome(): string {
  const home = marshallHome();
  for (const dir of [home, logDir(), handoffDir()]) {
    mkdirSync(dir, { recursive: true });
  }
  return home;
}
