// Last edited: 2026-09-21 00:05 CDT
// Tiny JSONL logger. One line per call, appended to ~/.marshall/logs/marshall.log.
// Mirrors to stderr on a TTY unless MARSHALL_QUIET is set. `rotateLog` is size-based and runs
// once at daemon start (`marshall run`), for this log and launchd's two.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
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

export const ROTATE_MAX_BYTES = 5 * 1024 * 1024;
export const ROTATE_KEEP = 3;

/**
 * Rotate `path` when it is over `maxBytes`: `path` → `path.1`, `path.1` → `path.2`, ... and the
 * oldest beyond `keep` is deleted. Returns true when a rotation happened. A missing file is fine.
 * Not safe against a writer holding the file open: run it before the daemon starts logging.
 */
export function rotateLog(path: string, maxBytes = ROTATE_MAX_BYTES, keep = ROTATE_KEEP): boolean {
  if (!existsSync(path) || statSync(path).size <= maxBytes) return false;
  const oldest = `${path}.${keep}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let n = keep - 1; n >= 1; n--) {
    const from = `${path}.${n}`;
    if (existsSync(from)) renameSync(from, `${path}.${n + 1}`);
  }
  renameSync(path, `${path}.1`);
  return true;
}
