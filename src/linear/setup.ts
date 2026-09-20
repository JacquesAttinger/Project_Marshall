// Last edited: 2026-09-19 22:25 CDT
// Idempotent workspace setup: the Needs Verification state, the agent-filed label, and the
// marshall label group with one child per agent slot. Reads team metadata once, creates only what is missing.

import type { Logger } from "../log.ts";
import { run } from "./client.ts";
import type { Gql } from "./gql.ts";
import {
  AGENT_FILED_LABEL,
  AGENT_IDS,
  IN_PROGRESS_STATE,
  MARSHALL_LABEL_GROUP,
  NEEDS_VERIFICATION_STATE,
} from "./map.ts";
import { CreateLabel, CreateState, type TeamMeta, TeamMetaOp } from "./queries.ts";

export const NEEDS_VERIFICATION_COLOR = "#f2c94c";

export interface Ensured {
  id: string;
  name: string;
  created: boolean;
}

export interface SetupResult {
  needsVerification: Ensured;
  agentFiled: Ensured;
  marshallGroup: Ensured;
  agents: Ensured[];
}

type State = TeamMeta["states"]["nodes"][number];
type Label = TeamMeta["labels"]["nodes"][number];

/** Midway between In Progress and the next state, or In Progress + 1 when it is last. */
export function positionAfterInProgress(states: State[]): number {
  const sorted = [...states].sort((a, b) => a.position - b.position);
  const idx = sorted.findIndex((s) => s.name === IN_PROGRESS_STATE);
  if (idx < 0) return (sorted.at(-1)?.position ?? 0) + 1;
  const current = sorted[idx] as State;
  const next = sorted[idx + 1];
  return next ? (current.position + next.position) / 2 : current.position + 1;
}

async function ensureState(gql: Gql, teamId: string, states: State[], log: Logger) {
  const existing = states.find((s) => s.name === NEEDS_VERIFICATION_STATE);
  if (existing) return { id: existing.id, name: existing.name, created: false };
  const position = positionAfterInProgress(states);
  const { workflowStateCreate } = await run(gql, CreateState, {
    input: {
      teamId,
      name: NEEDS_VERIFICATION_STATE,
      type: "started",
      color: NEEDS_VERIFICATION_COLOR,
      position,
    },
  });
  log.info("linear.setup.state_created", { name: NEEDS_VERIFICATION_STATE, position });
  return {
    id: workflowStateCreate.workflowState.id,
    name: NEEDS_VERIFICATION_STATE,
    created: true,
  };
}

interface LabelSpec {
  name: string;
  isGroup?: boolean;
  parentId?: string;
  parentName?: string;
}

async function ensureLabel(
  gql: Gql,
  teamId: string,
  labels: Label[],
  spec: LabelSpec,
  log: Logger,
): Promise<Ensured> {
  const existing = labels.find(
    (l) => l.name === spec.name && (l.parent?.name ?? undefined) === spec.parentName,
  );
  if (existing) return { id: existing.id, name: spec.name, created: false };
  const input: Record<string, unknown> = { teamId, name: spec.name };
  if (spec.isGroup) input.isGroup = true;
  if (spec.parentId) input.parentId = spec.parentId;
  const { issueLabelCreate } = await run(gql, CreateLabel, { input });
  log.info("linear.setup.label_created", { name: spec.name, parent: spec.parentName ?? null });
  return { id: issueLabelCreate.issueLabel.id, name: spec.name, created: true };
}

export async function ensureWorkspaceSetup(
  gql: Gql,
  teamId: string,
  log: Logger,
): Promise<SetupResult> {
  const { team } = await run(gql, TeamMetaOp, { id: teamId });
  const states = team.states.nodes;
  const labels = team.labels.nodes;
  const needsVerification = await ensureState(gql, teamId, states, log);
  const agentFiled = await ensureLabel(gql, teamId, labels, { name: AGENT_FILED_LABEL }, log);
  const marshallGroup = await ensureLabel(
    gql,
    teamId,
    labels,
    { name: MARSHALL_LABEL_GROUP, isGroup: true },
    log,
  );
  const agents: Ensured[] = [];
  for (const agentId of AGENT_IDS) {
    agents.push(
      await ensureLabel(
        gql,
        teamId,
        labels,
        { name: agentId, parentId: marshallGroup.id, parentName: MARSHALL_LABEL_GROUP },
        log,
      ),
    );
  }
  return { needsVerification, agentFiled, marshallGroup, agents };
}
