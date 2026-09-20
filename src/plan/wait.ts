// Last edited: 2026-09-20 10:56 CDT
// A RunWaiter built on the runner's watcher: resolves a promise per run id when the terminal hook
// event lands. Step 08 will own one watcher for every run; the CLI builds one per command.

import type { Database } from "bun:sqlite";
import {
  getRun,
  isTerminal,
  startWatcher,
  type Terminal,
  type WatcherOpts,
} from "../runner/index.ts";
import type { RunWaiter } from "./types.ts";

/** The terminal state already recorded on a run row, or null while it is still active. */
export function terminalOf(db: Database, runId: string): Terminal | null {
  const run = getRun(db, runId);
  if (!run || !isTerminal(run.state)) return null;
  if (run.state === "finished") return { kind: "finished" };
  return { kind: "failed", error: run.error ?? run.state };
}

export function createRunWaiter(db: Database, opts: WatcherOpts = {}): RunWaiter {
  const pending = new Map<string, (t: Terminal) => void>();
  const watcher = startWatcher(
    db,
    (run, _event, terminal) => {
      const resolve = pending.get(run.runId);
      if (!resolve) return;
      pending.delete(run.runId);
      resolve(terminal);
    },
    opts,
  );
  return {
    wait(runId, timeoutMs) {
      // The event may have been ingested before this call registered.
      const already = terminalOf(db, runId);
      if (already) return Promise.resolve(already);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(runId);
          resolve(null);
        }, timeoutMs);
        pending.set(runId, (t) => {
          clearTimeout(timer);
          resolve(t);
        });
        void watcher.scan();
      });
    },
    stop: () => watcher.stop(),
  };
}
