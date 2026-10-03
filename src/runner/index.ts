// Last edited: 2026-10-03 18:15 CDT
// Public API of the agent runner. Step 08 imports from here and nowhere else in src/runner.

export { claudeBin } from "./claude.ts";
export {
  classify,
  failureDetails,
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
  stalledFrom,
  status,
  statusFrom,
  transcriptMtime,
} from "./status.ts";
export {
  getRun,
  getRunByJob,
  isTerminal,
  lastStopFailure,
  latestRunInCwd,
  latestRunNamed,
  listActiveRuns,
  newestHookEventAt,
} from "./store.ts";
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
