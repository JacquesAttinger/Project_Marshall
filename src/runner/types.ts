// Last edited: 2026-09-19 22:55 CDT
// Public shapes for the agent runner. Nothing here knows about Linear or issues.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LaunchOpts {
  /** Display name for `claude --name`. Step 08 passes the issue id. */
  name: string;
  cwd: string;
  prompt: string;
  /** Model alias or id, passed straight to `--model` (`opus`, `fable`, `haiku`, ...). */
  model: string;
  effort?: Effort;
  systemPromptAppend?: string;
  maxBudgetUsd?: number;
  /** Escape hatch for later steps (`--plugin-dir`, `--add-dir`, ...). Appended before the prompt. */
  extraArgs?: string[];
}

export interface ResumeOpts extends Omit<LaunchOpts, "model"> {
  /** The Claude session to continue. Must be stopped; a running one would be copied. */
  sessionId: string;
  model?: string;
}

export type RunState = "starting" | "running" | "finished" | "failed" | "killed";

/** One row of the `runs` table. */
export interface Run {
  runId: string;
  /** The daemon's short id, once `claude --bg` has printed it. */
  jobId: string | null;
  /** The Claude session id, once a `SessionStart` hook or `state.json` reveals it. */
  sessionId: string | null;
  name: string;
  cwd: string;
  state: RunState;
  error: string | null;
  resumedFrom: string | null;
  eventsOffset: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunStatus {
  run: Run;
  /** The daemon lists the job with a live process (`pid` present in `claude agents --json`). */
  alive: boolean;
  /** `state` from `claude agents --json` (`working`, `done`, `failed`), or null when not listed. */
  daemonState: string | null;
  /** Newest of: transcript mtime, newest hook event. Null before either exists. */
  lastActivityAt: string | null;
  tokens: number | null;
}

/** One line of a run's events file, after ingest. */
export interface HookEvent {
  receivedAt: string;
  runId: string;
  /** `hook_event_name` from the payload (`Stop`, `StopFailure`, ...). */
  name: string;
  payload: Record<string, unknown>;
}

export type Terminal = { kind: "finished" } | { kind: "failed"; error: string };

export class RunnerError extends Error {
  override name = "RunnerError";
}
