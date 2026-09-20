// Last edited: 2026-09-19 22:45 CDT
// Public API of the agent runner. Step 08 imports from here and nowhere else in src/runner.

export { claudeBin } from "./claude.ts";
export {
  classify,
  failureKind,
  ingestFile,
  processRun,
  rateLimited,
  startWatcher,
  stopJob,
  type TerminalHandler,
  type Watcher,
  type WatcherOpts,
} from "./events.ts";
export { buildArgv, kill, launch, mintRunId, resume } from "./launch.ts";
export { buildAgentSettings, eventsFile, HOOK_EVENTS, type HookEventName } from "./settings.ts";
export {
  type DaemonSession,
  isStalled,
  type JobState,
  listDaemonSessions,
  readJobState,
  status,
  transcriptMtime,
} from "./status.ts";
export { getRun, getRunByJob, isTerminal, listActiveRuns } from "./store.ts";
export type {
  Effort,
  HookEvent,
  LaunchOpts,
  ResumeOpts,
  Run,
  RunState,
  RunStatus,
  Terminal,
} from "./types.ts";
export { RunnerError } from "./types.ts";
