// Last edited: 2026-09-19 21:28 CDT
// Tiny JSONL logger. One line per call, appended to ~/.marshall/logs/marshall.log.
// Mirrors to stderr on a TTY unless MARSHALL_QUIET is set. No rotation (step 09).

import { appendFileSync, mkdirSync } from "node:fs";
import { logDir, logPath } from "./paths.ts";

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

function shouldMirror(): boolean {
  return Boolean(process.stderr.isTTY) && !process.env.MARSHALL_QUIET;
}

function write(level: Level, event: string, base: Fields, fields: Fields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...base, ...fields });
  mkdirSync(logDir(), { recursive: true });
  appendFileSync(logPath(), `${line}\n`);
  if (shouldMirror()) process.stderr.write(`${line}\n`);
}

/** Build a logger. `base` fields (for example issueId, agentId) go on every line. */
export function createLogger(base: Fields = {}): Logger {
  return {
    debug: (event, fields = {}) => write("debug", event, base, fields),
    info: (event, fields = {}) => write("info", event, base, fields),
    warn: (event, fields = {}) => write("warn", event, base, fields),
    error: (event, fields = {}) => write("error", event, base, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}
