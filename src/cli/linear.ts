// Last edited: 2026-09-20 15:15 CDT
// `marshall linear setup [--json]` — create the state and labels the loop needs. Idempotent.

import { loadConfig, loadEnv, requireLinearApiKey } from "../config.ts";
import type { RateBudget } from "../linear/index.ts";
import {
  createGql,
  ensureWorkspaceSetup,
  type SetupResult,
  verifyWorkspace,
} from "../linear/index.ts";
import { createLogger } from "../log.ts";

export interface LinearSetupOptions {
  json: boolean;
  configPath?: string;
  fetchImpl?: typeof fetch;
}

export interface LinearSetupReport {
  workspace: string;
  user: string;
  teamId: string;
  result: SetupResult;
  budget: RateBudget | null;
}

export async function collectLinearSetup(opts: LinearSetupOptions): Promise<LinearSetupReport> {
  const config = loadConfig(opts.configPath);
  const apiKey = requireLinearApiKey(loadEnv());
  const log = createLogger({ command: "linear setup" });
  const gql = createGql({ apiKey, log, fetchImpl: opts.fetchImpl });
  const viewer = await verifyWorkspace(gql, config.workspace);
  const result = await ensureWorkspaceSetup(gql, config.teamId, log);
  return {
    workspace: viewer.workspace,
    user: viewer.name,
    teamId: config.teamId,
    result,
    budget: gql.lastBudget,
  };
}

export function formatLinearSetup(report: LinearSetupReport): string {
  const { result } = report;
  const rows: [string, string, string][] = [
    ["state", result.needsVerification.name, result.needsVerification.id],
    ["state", result.blocked.name, result.blocked.id],
    ["label", result.agentFiled.name, result.agentFiled.id],
    ["group", result.marshallGroup.name, result.marshallGroup.id],
    ...result.agents.map(
      (a) => ["label", `${result.marshallGroup.name}/${a.name}`, a.id] as [string, string, string],
    ),
  ];
  const created = [
    result.needsVerification,
    result.blocked,
    result.agentFiled,
    result.marshallGroup,
    ...result.agents,
  ]
    .filter((e) => e.created)
    .map((e) => e.name);
  const nameWidth = Math.max(...rows.map(([, n]) => n.length));
  const lines = [
    `Workspace ${report.workspace} as ${report.user}, team ${report.teamId}`,
    "",
    ...rows.map(([kind, name, id]) => `${kind.padEnd(5)}  ${name.padEnd(nameWidth)}  ${id}`),
    "",
    created.length > 0 ? `Created: ${created.join(", ")}` : "Created: nothing (already set up)",
  ];
  if (report.budget) {
    lines.push(
      `Rate budget: ${report.budget.remaining}/${report.budget.limit} until ${report.budget.resetAt}`,
    );
  }
  return lines.join("\n");
}

export async function runLinearSetup(opts: LinearSetupOptions): Promise<void> {
  const report = await collectLinearSetup(opts);
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatLinearSetup(report));
}
