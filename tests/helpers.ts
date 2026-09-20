// Last edited: 2026-09-19 22:40 CDT
// Shared test setup: an isolated MARSHALL_HOME per test so nothing touches ~/.marshall.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../src/log.ts";

export interface TempHome {
  dir: string;
  restore(): void;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Point MARSHALL_HOME at a fresh temp dir and clear MARSHALL_CONFIG. Call `restore()` in afterEach. */
export function useTempHome(prefix = "marshall-test-"): TempHome {
  const previousHome = process.env.MARSHALL_HOME;
  const previousConfig = process.env.MARSHALL_CONFIG;
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.MARSHALL_HOME = dir;
  delete process.env.MARSHALL_CONFIG;
  return {
    dir,
    restore() {
      restoreEnv("MARSHALL_HOME", previousHome);
      restoreEnv("MARSHALL_CONFIG", previousConfig);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Write a valid config into the temp home and point MARSHALL_CONFIG at it.
 * `repoPath` is the temp dir itself, so the directory check passes on any machine (CI has no ~/code).
 */
export function useTempConfig(home: TempHome, overrides: Record<string, unknown> = {}): string {
  const path = join(home.dir, "marshall.config.json");
  writeFileSync(
    path,
    JSON.stringify({ workspace: "test", teamId: "team-test", repoPath: home.dir, ...overrides }),
  );
  process.env.MARSHALL_CONFIG = path;
  return path;
}

export interface LogLine {
  level: string;
  event: string;
  fields: Record<string, unknown>;
}

/** An in-memory Logger. Nothing touches disk, and tests can assert on what was logged. */
export function recordingLogger(base: Record<string, unknown> = {}): {
  log: Logger;
  lines: LogLine[];
} {
  const lines: LogLine[] = [];
  const make = (fields: Record<string, unknown>): Logger => {
    const push =
      (level: string) =>
      (event: string, extra: Record<string, unknown> = {}) => {
        lines.push({ level, event, fields: { ...fields, ...extra } });
      };
    return {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
      child: (more) => make({ ...fields, ...more }),
    };
  };
  return { log: make(base), lines };
}
