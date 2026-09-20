// Last edited: 2026-09-19 21:28 CDT
// Shared test setup: an isolated MARSHALL_HOME per test so nothing touches ~/.marshall.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempHome {
  dir: string;
  restore(): void;
}

/** Point MARSHALL_HOME at a fresh temp dir. Call `restore()` in afterEach. */
export function useTempHome(prefix = "marshall-test-"): TempHome {
  const previous = process.env.MARSHALL_HOME;
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.MARSHALL_HOME = dir;
  return {
    dir,
    restore() {
      if (previous === undefined) delete process.env.MARSHALL_HOME;
      else process.env.MARSHALL_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
