// Last edited: 2026-09-19 21:36 CDT
// Shared test setup: an isolated MARSHALL_HOME per test so nothing touches ~/.marshall.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  writeFileSync(path, JSON.stringify({ workspace: "test", repoPath: home.dir, ...overrides }));
  process.env.MARSHALL_CONFIG = path;
  return path;
}
