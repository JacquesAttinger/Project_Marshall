// Last edited: 2026-09-20 23:55 CDT
// Names the phases and the plugin skills agree on: run names (`<ID> <phase>`, what the master
// agent looks up after a restart), the prompts, and the planner's revision commit subject.

export type PhaseRunKind = "plan" | "implement" | "handoff" | "resolve";

export function runName(identifier: string, kind: PhaseRunKind): string {
  return `${identifier} ${kind}`;
}

/** `plugin/skills/plan/SKILL.md` commits a revision as `Plan: revision N`. */
export function PLAN_REVISION_SUBJECT(revision: number): string {
  return `Plan: revision ${revision}`;
}

export function implementPrompt(planPath: string, identifier: string): string {
  return `/marshall:implement ${planPath} ${identifier}`;
}

export const RESOLVE_STATUS_FILE = "resolve.json";

export function resolvePrompt(
  planPath: string,
  identifier: string,
  mode: "conflict" | "ci",
): string {
  return `/marshall:resolve-conflicts ${planPath} ${identifier} ${mode}`;
}

/** The nudge a resumed implement session gets; the skill's preflight reads implement.json. */
export const IMPLEMENT_RESUME_PROMPT =
  "Your session was interrupted. Read $MARSHALL_ISSUE_DIR/implement.json and continue " +
  "/marshall:implement from the phase it records. The PR, if any, is reused, never recreated.";
