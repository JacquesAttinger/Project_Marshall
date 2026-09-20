// Last edited: 2026-09-20 16:40 CDT
// Public API of the hand-off phase. Step 08 imports from here and nowhere else in src/handoff.

export { type HandoffMeta, HandoffMetaSchema, readHandoffMeta, writeHandoffMeta } from "./meta.ts";
export { handoffEnv, runHandoffPhase, writeHandoff } from "./phase.ts";
export { type PostInput, postHandoff } from "./post.ts";
export { readPrBody, writePrBody } from "./pr.ts";
export { renderPackage } from "./render.ts";
export { type SpliceResult, spliceHandoff } from "./splice.ts";
export {
  BRANCH_LINE,
  FOLLOWUPS_LABEL,
  type GhRunner,
  HANDOFF_END,
  HANDOFF_HEADING,
  HANDOFF_PLACEHOLDER,
  HANDOFF_SECTIONS,
  HANDOFF_START,
  type HandoffCheck,
  HandoffError,
  type HandoffFailure,
  type HandoffPhaseInput,
  type HandoffPhaseResult,
  type PostFailure,
  type PostResult,
  PR_URL_PATTERN,
  REVIEW_NOTES_LABEL,
  ROUND_HEADING,
  type SpliceAction,
  type WriteInput,
  type WriteOutcome,
} from "./types.ts";
export {
  checkHandoffFile,
  checkHandoffText,
  type Expected,
  recipeFacts,
  roundOf,
  TEMPLATE_PATH,
} from "./validate.ts";
