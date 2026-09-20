// Last edited: 2026-09-19 22:10 CDT
// Pure mappers from Linear's raw issue shape to Marshall's types. No fetch, so tests hit them directly.

import type { RawIssue, RawIssueDetail } from "./queries.ts";

export const AGENT_IDS = ["agent-0", "agent-1", "agent-2"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Label group that holds one child label per agent slot: `marshall/agent-0` and so on. */
export const MARSHALL_LABEL_GROUP = "marshall";
export const AGENT_FILED_LABEL = "agent-filed";
export const NEEDS_VERIFICATION_STATE = "Needs Verification";
export const IN_PROGRESS_STATE = "In Progress";
export const TODO_STATE = "Todo";

/** Agents act as the same Linear user as the human, so this footer is how the two are told apart. */
export const MARSHALL_COMMENT_FOOTER = "\n\n_— Marshall_";

export interface IssueComment {
  id: string;
  body: string;
  createdAt: string;
  fromMarshall: boolean;
}

export interface PickableIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  url: string;
  branchName: string;
  createdAt: string;
  /** Full names; children of a group are `group/child`. */
  labels: string[];
  /** Oldest first. */
  comments: IssueComment[];
}

export interface IssueDetail extends PickableIssue {
  state: { name: string; type: string };
  agentId: AgentId | null;
  latestHumanComment: IssueComment | null;
  relatedIssueIds: string[];
}

type RawLabel = RawIssue["labels"]["nodes"][number];

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

/** `marshall/agent-0` for a child of the marshall group, the plain name otherwise. */
export function fullLabelName(label: { name: string; parent: { name: string } | null }): string {
  return label.parent ? `${label.parent.name}/${label.name}` : label.name;
}

export function agentLabelName(agentId: AgentId): string {
  return `${MARSHALL_LABEL_GROUP}/${agentId}`;
}

/** Every agent slot label on the issue. More than one means a claim went wrong. */
export function agentLabelsOf(labels: RawLabel[]): AgentId[] {
  return labels
    .filter((l) => l.parent?.name === MARSHALL_LABEL_GROUP && isAgentId(l.name))
    .map((l) => l.name as AgentId);
}

export function agentLabelOf(labels: RawLabel[]): AgentId | null {
  return agentLabelsOf(labels)[0] ?? null;
}

export function isFromMarshall(body: string): boolean {
  return body.trimEnd().endsWith(MARSHALL_COMMENT_FOOTER.trim());
}

function toComments(raw: RawIssue): IssueComment[] {
  return raw.comments.nodes
    .map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
      fromMarshall: isFromMarshall(c.body),
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function toPickable(raw: RawIssue): PickableIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description,
    priority: raw.priority,
    url: raw.url,
    branchName: raw.branchName,
    createdAt: raw.createdAt,
    labels: raw.labels.nodes.map(fullLabelName),
    comments: toComments(raw),
  };
}

export function toDetail(raw: RawIssueDetail): IssueDetail {
  const base = toPickable(raw);
  const human = base.comments.filter((c) => !c.fromMarshall);
  const related = [
    ...raw.relations.nodes.map((r) => r.relatedIssue.id),
    ...raw.inverseRelations.nodes.map((r) => r.issue.id),
  ];
  return {
    ...base,
    state: { name: raw.state.name, type: raw.state.type },
    agentId: agentLabelOf(raw.labels.nodes),
    latestHumanComment: human.at(-1) ?? null,
    relatedIssueIds: Array.from(new Set(related)),
  };
}
