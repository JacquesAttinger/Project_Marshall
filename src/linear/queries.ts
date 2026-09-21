// Last edited: 2026-09-21 15:10 CDT
// One GraphQL document plus its Zod response schema per Linear operation Marshall uses.
// Field names follow Linear's public schema. Keep documents minimal: every field costs complexity.

import { z } from "zod";
import { HUMAN_ONLY_LABEL } from "./map.ts";

export interface Operation<T> {
  name: string;
  doc: string;
  schema: z.ZodType<T>;
}

const ISSUE_FIELDS = `fragment IssueFields on Issue {
  id
  identifier
  title
  description
  priority
  url
  branchName
  createdAt
  updatedAt
  state { id name type }
  labels { nodes { id name parent { name } } }
  comments(last: 25) { nodes { id body createdAt } }
}`;

export const RawIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  priority: z.number(),
  url: z.string(),
  branchName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  state: z.object({ id: z.string(), name: z.string(), type: z.string() }),
  labels: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        parent: z.object({ name: z.string() }).nullable(),
      }),
    ),
  }),
  comments: z.object({
    nodes: z.array(z.object({ id: z.string(), body: z.string(), createdAt: z.string() })),
  }),
});
export type RawIssue = z.infer<typeof RawIssueSchema>;

export const RawIssueDetailSchema = RawIssueSchema.extend({
  relations: z.object({
    nodes: z.array(z.object({ type: z.string(), relatedIssue: z.object({ id: z.string() }) })),
  }),
  inverseRelations: z.object({
    nodes: z.array(z.object({ type: z.string(), issue: z.object({ id: z.string() }) })),
  }),
});
export type RawIssueDetail = z.infer<typeof RawIssueDetailSchema>;

export const Viewer: Operation<{
  viewer: { id: string; name: string; organization: { urlKey: string } };
}> = {
  name: "Viewer",
  doc: `query Viewer { viewer { id name organization { urlKey } } }`,
  schema: z.object({
    viewer: z.object({
      id: z.string(),
      name: z.string(),
      organization: z.object({ urlKey: z.string() }),
    }),
  }),
};

export const TeamMetaSchema = z.object({
  team: z.object({
    id: z.string(),
    key: z.string(),
    states: z.object({
      nodes: z.array(
        z.object({ id: z.string(), name: z.string(), type: z.string(), position: z.number() }),
      ),
    }),
    labels: z.object({
      nodes: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          isGroup: z.boolean(),
          parent: z.object({ id: z.string(), name: z.string() }).nullable(),
        }),
      ),
    }),
  }),
});
export type TeamMeta = z.infer<typeof TeamMetaSchema>["team"];

export const TeamMetaOp: Operation<z.infer<typeof TeamMetaSchema>> = {
  name: "TeamMeta",
  doc: `query TeamMeta($id: String!) {
  team(id: $id) {
    id
    key
    states { nodes { id name type position } }
    labels { nodes { id name isGroup parent { id name } } }
  }
}`,
  schema: TeamMetaSchema,
};

export const PickableIssues: Operation<{ issues: { nodes: RawIssue[] } }> = {
  name: "PickableIssues",
  doc: `${ISSUE_FIELDS}
query PickableIssues($teamId: ID!, $assigneeId: ID!) {
  issues(
    filter: {
      team: { id: { eq: $teamId } }
      assignee: { id: { eq: $assigneeId } }
      state: { type: { eq: "unstarted" } }
      labels: { every: { name: { neq: "${HUMAN_ONLY_LABEL}" } } }
    }
    first: 50
  ) {
    nodes { ...IssueFields }
  }
}`,
  schema: z.object({ issues: z.object({ nodes: z.array(RawIssueSchema) }) }),
};

export const IssueById: Operation<{ issue: RawIssueDetail }> = {
  name: "IssueById",
  doc: `${ISSUE_FIELDS}
query IssueById($id: String!) {
  issue(id: $id) {
    ...IssueFields
    relations { nodes { type relatedIssue { id } } }
    inverseRelations { nodes { type issue { id } } }
  }
}`,
  schema: z.object({ issue: RawIssueDetailSchema }),
};

const SuccessSchema = z.object({ success: z.boolean() });

export const UpdateIssue: Operation<{ issueUpdate: { success: boolean; issue: { id: string } } }> =
  {
    name: "UpdateIssue",
    doc: `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id } }
}`,
    schema: z.object({
      issueUpdate: SuccessSchema.extend({ issue: z.object({ id: z.string() }) }),
    }),
  };

const CommentPayloadSchema = SuccessSchema.extend({ comment: z.object({ id: z.string() }) });

export const CreateComment: Operation<{
  commentCreate: { success: boolean; comment: { id: string } };
}> = {
  name: "CreateComment",
  doc: `mutation CreateComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`,
  schema: z.object({ commentCreate: CommentPayloadSchema }),
};

/** Edit a comment in place. The hand-off re-post uses it so a bounce never adds a second comment. */
export const UpdateComment: Operation<{
  commentUpdate: { success: boolean; comment: { id: string } };
}> = {
  name: "UpdateComment",
  doc: `mutation UpdateComment($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { success comment { id } }
}`,
  schema: z.object({ commentUpdate: CommentPayloadSchema }),
};

export const CreateIssue: Operation<{
  issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } };
}> = {
  name: "CreateIssue",
  doc: `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`,
  schema: z.object({
    issueCreate: SuccessSchema.extend({
      issue: z.object({ id: z.string(), identifier: z.string(), url: z.string() }),
    }),
  }),
};

export const CreateRelation: Operation<{ issueRelationCreate: { success: boolean } }> = {
  name: "CreateRelation",
  doc: `mutation CreateRelation($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`,
  schema: z.object({ issueRelationCreate: SuccessSchema }),
};

export const CreateState: Operation<{
  workflowStateCreate: { success: boolean; workflowState: { id: string } };
}> = {
  name: "CreateState",
  doc: `mutation CreateState($input: WorkflowStateCreateInput!) {
  workflowStateCreate(input: $input) { success workflowState { id } }
}`,
  schema: z.object({
    workflowStateCreate: SuccessSchema.extend({ workflowState: z.object({ id: z.string() }) }),
  }),
};

export const CreateLabel: Operation<{
  issueLabelCreate: { success: boolean; issueLabel: { id: string } };
}> = {
  name: "CreateLabel",
  doc: `mutation CreateLabel($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id } }
}`,
  schema: z.object({
    issueLabelCreate: SuccessSchema.extend({ issueLabel: z.object({ id: z.string() }) }),
  }),
};

/** Moves the issue to Linear's 30-day trash. E2E cleanup only. */
export const DeleteIssue: Operation<{ issueDelete: { success: boolean } }> = {
  name: "DeleteIssue",
  doc: `mutation DeleteIssue($id: String!) {
  issueDelete(id: $id) { success }
}`,
  schema: z.object({ issueDelete: SuccessSchema }),
};
