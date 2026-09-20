// Last edited: 2026-09-20 16:20 CDT
// The sidecar next to the hand-off file: what was posted where. A re-post reads it to edit the
// same Linear comment instead of adding one, and to number the next round.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { handoffMetaPath } from "../paths.ts";
import { HandoffError } from "./types.ts";

export const HandoffMetaSchema = z
  .object({
    issueId: z.string().min(1),
    /** The Linear comment that holds the package. */
    commentId: z.string().min(1),
    round: z.number().int().min(1),
    prUrl: z.string().url(),
    postedAt: z.string().datetime({ offset: true }),
    /** The badge line rendered under the TLDR, when the last post carried one. */
    badge: z.string().min(1).optional(),
  })
  .strict();

export type HandoffMeta = z.infer<typeof HandoffMetaSchema>;

/** The sidecar, or null before the first post. A malformed file throws HandoffError. */
export function readHandoffMeta(issueId: string): HandoffMeta | null {
  const path = handoffMetaPath(issueId);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new HandoffError(
      `hand-off sidecar is not valid JSON: ${path} (${(err as Error).message})`,
    );
  }
  const result = HandoffMetaSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new HandoffError(`Invalid hand-off sidecar at ${path}: ${issues}`);
  }
  return result.data;
}

/** Write the sidecar through a temp file and a rename. Returns its path. */
export function writeHandoffMeta(issueId: string, meta: HandoffMeta): string {
  const path = handoffMetaPath(issueId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(HandoffMetaSchema.parse(meta), null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}
