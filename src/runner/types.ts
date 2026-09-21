// Last edited: 2026-09-20 23:00 CDT
// Public shapes for the agent runner. Nothing here knows about Linear or issues.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LaunchOpts {
  /** Display name for `claude --name`. Step 08 passes the issue id. */
  name: string;
  /** Pre-minted with `mintRunId()`, so a caller can name files after the run before it starts. */
  runId?: string;
  cwd: string;
  prompt: string;
  /** Model alias or id, passed straight to `--model` (`opus`, `fable`, `haiku`, ...). */
  model: string;
  effort?: Effort;
  systemPromptAppend?: string;
  maxBudgetUsd?: number;
  /** Escape hatch for later steps (`--plugin-dir`, `--add-dir`, ...). Appended before the prompt. */
  extraArgs?: string[];
  /**
   * Environment for every Bash call the agent makes, merged into the settings `env` key.
   * Bash state does not persist between an agent's tool calls, so this is the only way to hand
   * the agent a value (a slot's Compose project name, the issue dir) that must hold for the run.
   */
  env?: Record<string, string>;
  /**
   * A JSON status file the agent writes (`implement.json`). While its `outcome` is null, a `Stop`
   * with no background tasks is blocked by the Stop hook (`scripts/stop-guard.ts`) and is not
   * terminal for the runner: the skill has more to do. Capped at 3 blocks per file.
   */
  statusFile?: string;
}

export interface ResumeOpts extends Omit<LaunchOpts, "model"> {
  /**
   * The Claude session to continue. Must be stopped. The daemon forks it into a new session id
   * and job id; the conversation carries over.
   */
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
  /** The Stop guard blocked this stop, so the agent was sent back to work. */
  stopBlocked?: boolean;
}

export type Terminal =
  | { kind: "finished" }
  | {
      kind: "failed";
      error: string;
      /** The hook's `error_details`, when present: a rate limit names its reset time here. */
      details?: string;
    };

export class RunnerError extends Error {
  override name = "RunnerError";
}
