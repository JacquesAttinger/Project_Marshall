// Last edited: 2026-09-20 10:55 CDT
// Per-slot isolation for agents that share one laptop: each slot gets its own Compose project
// name and its own host ports, handed to the agent through the settings `env` key (see
// docs/isolation.md). Nothing here runs Docker; the skill does, with these vars in its env.

import type { Config } from "./config.ts";
import { issueDir } from "./paths.ts";

export class IsolationError extends Error {
  override name = "IsolationError";
}

/** `marshall-<slot>`: the Compose project name, which also prefixes volumes and images. */
export function composeProjectName(slot: number): string {
  return `marshall-${slot}`;
}

function assertSlot(slot: number, config: Config): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= config.maxAgents) {
    throw new IsolationError(`slot must be an integer in [0, ${config.maxAgents}); got ${slot}`);
  }
}

/**
 * The env every Bash call in slot `slot` runs with: the slot number, the Compose project name,
 * and one host-port var per configured service (`base + slot * portOffsetPerSlot`).
 * Values are strings because they land in a settings JSON `env` block.
 */
export function slotEnv(slot: number, config: Config): Record<string, string> {
  assertSlot(slot, config);
  const env: Record<string, string> = {
    MARSHALL_SLOT: String(slot),
    COMPOSE_PROJECT_NAME: composeProjectName(slot),
  };
  for (const [name, base] of Object.entries(config.services)) {
    const portNumber = base + slot * config.portOffsetPerSlot;
    if (portNumber > 65535) {
      throw new IsolationError(`${name} for slot ${slot} would be ${portNumber}, above 65535`);
    }
    env[name] = String(portNumber);
  }
  return env;
}

/**
 * `slotEnv` plus what `/marshall:implement` needs: where its status file goes, the issue URL for
 * the PR body, and the review-cycle cap (`config.maxFixCycles`).
 */
export function implementEnv(
  issueId: string,
  issueUrl: string,
  slot: number,
  config: Config,
): Record<string, string> {
  return {
    ...slotEnv(slot, config),
    MARSHALL_ISSUE_DIR: issueDir(issueId),
    MARSHALL_ISSUE_URL: issueUrl,
    MARSHALL_MAX_CYCLES: String(config.maxFixCycles),
  };
}
