// Last edited: 2026-09-20 10:35 CDT
// Builds the inline `--settings` JSON for one agent run: the committed agent-settings.json
// plus a command hook per lifecycle event that appends to this run's events file.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eventsDir } from "../paths.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const AGENT_SETTINGS_PATH = resolve(REPO_ROOT, "agent-settings.json");
export const HOOK_SINK_PATH = resolve(REPO_ROOT, "scripts", "hook-sink.sh");

/** Every hook event the runner listens to. SessionStart gives the session id first. */
export const HOOK_EVENTS = [
  "SessionStart",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "Notification",
  "SessionEnd",
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** SessionEnd hooks get a shorter budget: Claude Code's default there is 1.5 s. */
const HOOK_TIMEOUT_SECONDS: Record<HookEventName, number> = {
  SessionStart: 5,
  Stop: 5,
  StopFailure: 5,
  SubagentStop: 5,
  Notification: 5,
  SessionEnd: 3,
};

type Json = Record<string, unknown>;
type HookGroup = { hooks: unknown[]; matcher?: string };

/** The events file for a run: `<MARSHALL_HOME>/events/<runId>.jsonl`. */
export function eventsFile(runId: string): string {
  return join(eventsDir(), `${runId}.jsonl`);
}

/** Single-quote a string for `/bin/sh`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function loadBaseSettings(path: string = AGENT_SETTINGS_PATH): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

/** The hook command for a run. The sink script and the events file are both absolute paths. */
export function hookCommand(runId: string): string {
  return `${shellQuote(HOOK_SINK_PATH)} ${shellQuote(eventsFile(runId))}`;
}

/**
 * Merge the run's hooks into the base settings and return the JSON string to pass as `--settings`.
 * Hooks already present in the base file are kept; ours are appended so both fire.
 * Hooks are synchronous so their order in the events file matches the order they fired.
 * `env` is merged over the base file's `env`, so a per-run value wins over a committed default.
 */
export function buildAgentSettings(
  runId: string,
  base: Json = loadBaseSettings(),
  env: Record<string, string> = {},
): string {
  const command = hookCommand(runId);
  const existing = (base.hooks ?? {}) as Record<string, HookGroup[]>;
  const hooks: Record<string, HookGroup[]> = { ...existing };
  for (const name of HOOK_EVENTS) {
    const group: HookGroup = {
      hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS[name] }],
    };
    hooks[name] = [...(existing[name] ?? []), group];
  }
  const baseEnv = (base.env ?? {}) as Record<string, string>;
  return JSON.stringify({ ...base, hooks, env: { ...baseEnv, ...env } });
}
