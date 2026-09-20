# Step 06 — Hand-off Package — Implementation Plan

<!-- Last edited: 2026-09-20 15:40 CDT -->

**TLDR:** After an agent finishes an issue and the PR is green, a second small agent writes a six-section note.
The note says where the feature is, what was wrong, what changed, and how to check it.
Code checks the note, posts it to Linear and into the PR body, and remembers what it posted so a re-post edits in place instead of adding noise.
Step 08 will call all of this as one function, the same way it calls planning today.

## Context

Spec section 7.1 and `docs/steps/06_handoff_package.md` define the package.
The step doc's five open questions were closed on 2026-09-20 (PR #8).
Today's grilling closed five implementation questions.
Nothing of step 06 exists in code yet: `handoffDir()` in `src/paths.ts` is the only trace.
Step 05 left a real, open, green PR (dvairus/ChessBuddy#36, issue CHE-5) that the example hand-off is written from.

## Decisions

From the step-doc grilling (already in the doc):
writer is a separate skill; Linear gets the full package; a bounce is a full rewrite plus an optional "Round N — what changed" block after the TLDR; the PR body section sits between `<!-- marshall-handoff:start -->` / `<!-- marshall-handoff:end -->`; section 5 lists only the files that matter.

From today's implementation grilling:

| # | Question | Decision |
|---|---|---|
| 1 | Module scope | Step 06 owns the full phase. `runHandoffPhase(...)` in `src/handoff/` mirrors `runPlanPhase`: launch `/marshall:handoff`, wait for Stop, check the worktree stayed clean, validate, post. Step 08 makes one call. CLI `marshall handoff check <file>`. |
| 2 | Linear re-post | Edit the comment in place. A sidecar `~/.marshall/handoffs/<ISSUE-ID>.json` stores the comment id, round, PR URL, badge. New `UpdateComment` mutation. No `claims` migration; the hand-off path is deterministic. |
| 3 | Writer scope | Read-only. It reads the plan, the diff, the code, and `gh pr view`. It never starts the app. Target under 10 minutes. |
| 4 | Invalid file | Resume the same session once with the validation errors. Still invalid → `{ ok: false, reason: "handoff_invalid" }`. |
| 5 | Review notes and follow-ups | Inside section 5 as two bold sub-lists: **Review notes (not fixed)** and **Follow-ups proposed** (titles only, from `implement.json`). |

Smaller calls set by recommendation (flag if you disagree):

- Config: `models.handoff` (optional; `handoffModel(config)` falls back to `models.planSimple`) and `handoffMinutes` (default 10).
- `src/gh.ts` mirrors `runGit`; binary from `MARSHALL_GH_BIN`; test shim `tests/fixtures/fake-gh` like `fake-claude`.
- The implement skill wraps its `_Filled in by the hand-off step._` placeholder in the two markers, so the first post is a replace.
- The template the writer copies lives in the plugin (`plugin/skills/handoff/template.md`), because the agent runs in the target repo and cannot read Marshall's `docs/`. `docs/handoff_template.md` is the human-facing explanation.
- Failure reasons use house casing: `handoff_invalid`, not `HANDOFF_INVALID`.
- `LinearClient.comment()` starts returning `{ id }`; one stub in `tests/plan/phase.test.ts:79` changes to return `{ id: "c1" }`.
- Naming follows the plugin convention: `plugin/skills/handoff/SKILL.md`, invoked as `/marshall:handoff <plan-path> <ISSUE-ID>`. The step doc's `skills/marshall-handoff/` gets corrected.

## Reuse (found in the code)

- `src/plan/phase.ts` — launch → wait → kill-on-timeout → fail shape, own-waiter handling, `PLUGIN_DIR`.
- `src/plan/template.ts` — `headings`, `normalize`, `sectionBody`, `tldrOf`, `hasTldrParagraph`, the missing/misordered loop. These move to `src/markdown.ts`; `template.ts` re-exports them so `src/plan/summary.ts` and `tests/plan/template.test.ts` do not change.
- `src/runner/launch.ts` — `launch`, `resume` (needs the run's `sessionId` from `getRun`), `kill`, `mintRunId`.
- `src/linear/client.ts` + `queries.ts` — `comment()`, `CreateComment` (extend to return `comment { id }`), pattern for `UpdateComment`.
- `src/implement/status.ts` — `readImplementStatus(identifier)` gives `prUrl`, `branch`, `reviewNotes`, `followups`.
- `src/paths.ts` — `handoffDir()`, `issueDir()`; add `handoffPath()`, `handoffMetaPath()`.
- `src/git.ts` — `runGit`, `gitLines`, `gitEnv` (model for `src/gh.ts`; also used for the worktree snapshot).
- Tests: `useTempHome`, `useRunnerEnv`, `fake-claude`, `tests/linear/fake-linear.ts`, `tests/plan/helpers.ts` (`makeRepo`, `commitFile`).

## Files

### New — shared

`src/markdown.ts`
```ts
export function normalizeHeading(heading: string): string;
export function headings(text: string): string[];            // H2 titles in order
export function hasTldrParagraph(text: string): boolean;
export function sectionBody(text: string, heading: string): string | null;
export function tldrOf(text: string): string | null;
export interface SectionCheck { missing: string[]; misordered: string[] }
export function checkRequiredSections(text: string, required: readonly string[]): SectionCheck;
```

`src/gh.ts`
```ts
export class GhError extends Error { override name = "GhError"; }
export function ghBin(): string;                                // MARSHALL_GH_BIN, else "gh"
export async function runGh(args: string[], cwd: string): Promise<string>;  // Bun.spawn, 60 s, GhError on non-zero
```

### New — `src/handoff/`

`types.ts` — constants, shapes, `HandoffError`.
```ts
export const HANDOFF_SECTIONS = ["TLDR", "Where to find it", "Orientation",
  "What was wrong and why", "What the agent did", "Verification recipe"] as const;
export const HANDOFF_START = "<!-- marshall-handoff:start -->";
export const HANDOFF_END = "<!-- marshall-handoff:end -->";
export const HANDOFF_HEADING = "## Hand-off";
export const HANDOFF_PLACEHOLDER = "_Filled in by the hand-off step._";
export const REVIEW_NOTES_LABEL = "Review notes (not fixed)";
export const FOLLOWUPS_LABEL = "Follow-ups proposed";
export const ROUND_HEADING = /^round\s+(\d+)\s*[—–-]+\s*what changed$/i;
export const PR_URL_PATTERN = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
export const BRANCH_LINE = /^\s*(?:[-*]\s*)?\**branch\**:?\**\s*:?\s*`?([^\s`]+)`?/im;

export interface HandoffCheck { ok: boolean; missing: string[]; misordered: string[];
  round: number | null; prUrl: string | null; branch: string | null; problems: string[] }

export interface HandoffPhaseInput {
  db: Database; linear: Pick<LinearClient, "comment" | "updateComment">; config: Config;
  issue: IssueDetail; cwd: string; planPath: string;   // planPath relative to cwd, from the claim
  round?: number;      // default: sidecar round + 1, else 1
  model?: string; base?: string; waiter?: RunWaiter; onLaunched?: (run: Run) => void; gh?: GhRunner;
}
export type WriteInput = Omit<HandoffPhaseInput, "linear" | "gh">;
export type HandoffFailure = "no_pr" | "worktree_dirty" | "launch_failed" | "run_failed"
  | "timeout" | "handoff_invalid" | "post_failed";
export type HandoffPhaseResult =
  | { ok: true; handoffPath: string; metaPath: string; commentId: string; round: number;
      prUrl: string; model: string; runId: string; resumed: boolean }
  | { ok: false; reason: HandoffFailure; detail: string; runId?: string; handoffPath?: string };
export type PostFailure = "invalid" | "markers_unbalanced" | "gh_failed" | "linear_failed";
export type PostResult =
  | { ok: true; commentId: string; commentAction: "created" | "updated";
      prAction: SpliceAction | "unchanged"; metaPath: string; text: string }
  | { ok: false; reason: PostFailure; detail: string };
export class HandoffError extends Error { override name = "HandoffError"; }
```

`validate.ts`
```ts
export const TEMPLATE_PATH: string;   // <repo>/plugin/skills/handoff/template.md
export interface Expected { prUrl?: string; branch?: string }
export function roundOf(text: string): number | null;
export function recipeFacts(text: string): { prUrl: string | null; branch: string | null };
export function checkHandoffText(text: string, expected?: Expected): HandoffCheck;
export function checkHandoffFile(path: string, expected?: Expected): HandoffCheck;  // missing file → problems: ["file not found: …"]
```
Rules: the six headings in order via `checkRequiredSections` (TLDR also satisfied by a `**TLDR:**` paragraph); an H2 matching `ROUND_HEADING` is optional and must sit before "Where to find it"; section 5 must contain both bold labels; section 6 must contain a PR URL and a branch line, and they must match `expected` when given.
`problems` lists every failure one per line; the resume nudge and the CLI print them.

`render.ts`
```ts
export function renderPackage(fileText: string, opts?: { badge?: string }): string;
```
Strips the H1 and the `<!-- Last edited -->` line; inserts `_<badge>_` right under the TLDR block.
The badge lives in the sidecar and in both posted copies, never in the `.md` file.

`splice.ts`
```ts
export type SpliceAction = "appended" | "filled_placeholder" | "inserted_after_heading" | "replaced";
export type SpliceResult =
  | { ok: true; body: string; action: SpliceAction; changed: boolean; removedDuplicates: number }
  | { ok: false; reason: "markers_unbalanced"; detail: string };
export function spliceHandoff(body: string, text: string, markers?: { start: string; end: string }): SpliceResult;
```

| Body state | Result | action |
|---|---|---|
| One `start` before one `end` | Replace the text between them; bytes outside untouched | `replaced` |
| No markers, `## Hand-off` heading, next non-blank line is the placeholder | Replace the placeholder line with `start\ntext\nend` | `filled_placeholder` |
| No markers, `## Hand-off` heading, no placeholder | Insert the block right after the heading; human text stays below | `inserted_after_heading` |
| No markers, no heading | Append `\n\n## Hand-off\n\n<block>\n` | `appended` |
| More than one pair | Replace the first; delete later pairs wholesale | `replaced`, `removedDuplicates: n` |
| Unbalanced markers | `{ ok: false, reason: "markers_unbalanced" }` | — |

`changed = newBody !== body`, so an idempotent re-post skips `gh pr edit`.
The `## Hand-off` heading stays outside the markers.

`meta.ts` — the sidecar, zod `.strict()`: `{ issueId, commentId, round, prUrl, postedAt, badge? }`.
```ts
export function readHandoffMeta(issueId: string): HandoffMeta | null;      // malformed → HandoffError
export function writeHandoffMeta(issueId: string, meta: HandoffMeta): string;  // tmp + rename
```

`pr.ts`
```ts
export type GhRunner = (args: string[], cwd: string) => Promise<string>;
export async function readPrBody(prUrl: string, cwd: string, gh?: GhRunner): Promise<string>;   // gh pr view <url> --json body, parsed in TS
export async function writePrBody(prUrl: string, body: string, issueId: string, cwd: string, gh?: GhRunner): Promise<void>;  // temp file under issueDir, gh pr edit --body-file
```
Do not use `--jq .body`: it appends a newline and breaks byte-identity outside the markers.

`post.ts`
```ts
export interface PostInput {
  issue: Pick<IssueDetail, "id" | "identifier">;      // id = UUID for Linear, identifier for paths
  linear: Pick<LinearClient, "comment" | "updateComment">;
  handoffPath?: string; prUrl: string; cwd: string; round: number; badge?: string;
  gh?: GhRunner; now?: () => Date;
}
export async function postHandoff(input: PostInput): Promise<PostResult>;
```
Order: validate → render → Linear (update when the sidecar has a comment id, else create) → **write the sidecar before touching the PR**, so a `gh` failure never loses the comment id → read body → splice → `gh pr edit` only when changed.

`phase.ts`
```ts
export function handoffEnv(issue: Pick<IssueDetail, "identifier" | "url">, prUrl: string, round: number, config: Config): Record<string, string>;
export async function writeHandoff(input: WriteInput): Promise<WriteOutcome>;       // launch, wait, verify, validate, resume once; no posting
export async function runHandoffPhase(input: HandoffPhaseInput): Promise<HandoffPhaseResult>;  // writeHandoff + postHandoff
```
Launch:
```ts
launch(db, {
  runId, name: `${issue.identifier} handoff`, cwd,
  model: input.model ?? handoffModel(config),
  prompt: `/marshall:handoff ${planPath} ${issue.identifier}`,
  extraArgs: ["--plugin-dir", PLUGIN_DIR],
  env: { MARSHALL_ISSUE_DIR, MARSHALL_ISSUE_URL, MARSHALL_HANDOFF_PATH, MARSHALL_ROUND, MARSHALL_BASE_BRANCH, MARSHALL_PR_URL },
});   // no statusFile: the output is markdown, validated by the orchestrator
```
Sequence in `writeHandoff`:
1. `readImplementStatus(identifier)`; null or `prUrl`/`branch` null → `no_pr`.
2. `round = input.round ?? (sidecar round ?? 0) + 1`.
3. Snapshot `git status --porcelain` and `HEAD`; dirty before launch → `worktree_dirty`.
4. Launch; catch → `launch_failed`.
5. `waiter.wait(runId, handoffMinutes * 60_000)`; null → `kill`, `timeout`; failed → `run_failed`.
6. Re-snapshot; porcelain non-empty or HEAD moved → `worktree_dirty`, nothing posted.
7. `checkHandoffFile(handoffPath, { prUrl, branch })`; ok → done.
8. First failure: `resume(db, { sessionId: getRun(db, runId).sessionId, name, cwd, prompt: nudge, model, extraArgs, env })` with the nudge `The hand-off at <path> failed validation: <problems>. Fix that file in place. Write nothing else, then stop.`; wait `max(2 min, remaining)`; repeat 6–7. Still invalid → `handoff_invalid`. No `sessionId` → `handoff_invalid` with "cannot resume".
9. `runHandoffPhase` then calls `postHandoff`; failure → `post_failed`.

`index.ts` — barrel; the only import surface for step 08.

`src/cli/handoff.ts` — `runHandoffCheck(file, json): number`; registered as `"handoff check"` (arity 1) in `src/cli/index.ts`.

### New — plugin

`plugin/skills/handoff/SKILL.md` (frontmatter: `name: handoff`, `argument-hint: <plan-path> <ISSUE-ID>`, `disable-model-invocation: true`).
Sections: Inputs (args, the six env vars, `template.md` in the skill's base dir) · Rules · Steps · The six sections · Round N.
Rules: no human; read-only worktree (no edits, commits, checkouts, app start, tests, formatters; `git fetch origin --quiet` allowed; scratch under `$MARSHALL_ISSUE_DIR`); one output, written tmp + `mv` to `$MARSHALL_HANDOFF_PATH`; no screenshots or logs; files that matter only; if the plan lacks a section (older hand-written plans do), derive it from the code; finish with one line `HANDOFF_WRITTEN <path> round <N>` or `HANDOFF_BLOCKED <reason>`.
Steps: preflight (args, env, plan, `implement.json`, `gh pr view` works) → read the plan's orientation sections → pin the diff (`merge-base origin/$MARSHALL_BASE_BRANCH HEAD`, `--stat`, read the files that matter) → read `implement.json` (`branch`, `prUrl`, `reviewNotes`, `followups`) → if `MARSHALL_ROUND > 1`, read the previous file and write the Round-N block → write from `template.md` → self-check headings → finish line.
Section 5 layout: the fix in prose; **Files that matter**; **Decisions made alone**; **Review notes (not fixed)** (verbatim or `(none)`); **Follow-ups proposed** (titles or `(none)`).
Section 6 layout: `- Branch:`, `- PR:`, `- Setup:`, `- Steps:` numbered, `- Expected:` one PASS line per step.

`plugin/skills/handoff/template.md` — H1 placeholder, Last-edited comment, `**TLDR:**`, then the five H2s with the section 5 bold labels and the section 6 lines.
A test asserts `headings(template)` equals `HANDOFF_SECTIONS.slice(1)`.

### New — fixtures, scripts, docs

- `tests/fixtures/fake-gh` — `#!/usr/bin/env bun`; logs argv to `$FAKE_GH_DIR/calls.log`; `pr view … --json body` prints `{"body": <$FAKE_GH_DIR/pr_body.md>}`; `pr edit … --body-file <f>` copies `<f>` to `pr_body.md`; `FAKE_GH_FAIL` → exit 1.
- `tests/fixtures/handoffs/{good,missing_sections,no_pr,round2,misordered,no_sublists}.md`; `tests/fixtures/pr_bodies/{fresh,legacy,posted,no_heading,heading_no_placeholder,double,unbalanced,crlf}.md`.
- `tests/handoff/helpers.ts` — `useGhEnv()`, `ghCalls()`, `setPrBody()`, `prBody()`, `writeImplementStatus(issueId, overrides)`, `fakeLinearStub()`.
- `scripts/launch-handoff.ts` — `--cwd --plan --issue [--round N] [--model] [--post] [--badge "…"] [--watch]`; `writeHandoff` alone, or plus `postHandoff` via `connectLinear` with `--post`.
- `docs/handoff.md` (shaped like `docs/planning.md`), `docs/handoff_template.md`, `docs/examples/step06_CHE-5/{README.md,handoff.md,handoff.json,pr_body_before.md,pr_body_after.md}`.

### Modified

| File | Change |
|---|---|
| `src/plan/template.ts` | Import from `../markdown.ts`; re-export `headings`, `hasTldrParagraph`, `sectionBody`, `tldrOf`; `checkPlanText` uses `checkRequiredSections`. |
| `src/paths.ts` | `handoffPath(issueId)` → `<handoffDir>/<ID>.md`; `handoffMetaPath(issueId)` → `<handoffDir>/<ID>.json`. Optionally host `PLUGIN_DIR` (re-exported from `src/plan/phase.ts`). |
| `src/config.ts` | `models.handoff: modelName.optional()`; `handoffMinutes: positiveInt.default(10)`; `export function handoffModel(config: Config): string`. |
| `marshall.config.json` | `"handoffMinutes": 10`; `"models.handoff"` explicit. |
| `src/linear/queries.ts` | `CreateComment` returns `comment { id }`; new `UpdateComment` (`commentUpdate(id: $id, input: $input) { success comment { id } }`). |
| `src/linear/client.ts` | `comment(): Promise<{ id: string }>`; new `updateComment(commentId, markdown): Promise<void>`; both append `MARSHALL_COMMENT_FOOTER`. |
| `tests/linear/fake-linear.ts` | Default handlers return `comment: { id: "comment-1" }`; add `UpdateComment`. |
| `tests/linear/client.test.ts`, `tests/plan/phase.test.ts:79` | Assert the id; stub returns `{ id: "c1" }`. |
| `src/cli/index.ts` | `"handoff check"` command + USAGE line. |
| `plugin/skills/implement/SKILL.md` §6 | `## Hand-off` holds exactly `<!-- marshall-handoff:start -->`, `_Filled in by the hand-off step._`, `<!-- marshall-handoff:end -->`; "the hand-off step replaces only the text between the markers." |
| `plugin/.claude-plugin/plugin.json` | Description adds `handoff`. |
| `tests/plugin.test.ts` | `REQUIRED_SKILLS` adds `"handoff"`; frontmatter, env-var, heading, and marker assertions. |
| `tests/paths.test.ts`, `tests/config.test.ts`, `tests/cli.test.ts` | New cases. |

## Tests

| File | Cases |
|---|---|
| `tests/markdown.test.ts` | required-sections good/missing/misordered; TLDR paragraph counts; `sectionBody` last section; `tldrOf` both styles |
| `tests/paths.test.ts` | `handoffPath`, `handoffMetaPath`; `ensureHome` creates `handoffs/` |
| `tests/config.test.ts` | `handoffMinutes` default; `handoffModel()` fallback and override |
| `tests/linear/client.test.ts` | `comment()` returns id; `updateComment` sends `{ id, input.body }` with footer |
| `tests/gh.test.ts` | `ghBin()` override; `runGh` stdout; failure → `GhError` with stderr |
| `tests/handoff/validate.test.ts` | good (prUrl + branch extracted); missing sections; no PR; round 2 ok; Round heading in the wrong place; misordered; missing sub-lists; expected-URL mismatch; file not found; template headings == `HANDOFF_SECTIONS.slice(1)`; heading case/punctuation insensitive |
| `tests/handoff/render.test.ts` | strips H1 + Last-edited; badge under both TLDR styles; no badge → identical |
| `tests/handoff/splice.test.ts` | one case per table row; re-post on own output → `changed: false`; CRLF bytes outside markers identical; `Closes` survives; exactly one `## Hand-off` after every action |
| `tests/handoff/meta.test.ts` | absent → null; round-trip; malformed → `HandoffError` |
| `tests/handoff/post.test.ts` | first post (comment with UUID, sidecar round 1, view then edit); re-post (`updateComment`, no `comment`, round 2); idempotent (`prAction: "unchanged"`, no edit); badge (comment text == text between markers, sidecar badge); gh fails after Linear → `gh_failed`, sidecar already written; invalid → nothing called; unbalanced → `markers_unbalanced` |
| `tests/handoff/phase.test.ts` | happy (argv, six env vars, comment, gh calls, sidecar); invalid-then-fixed (second `--bg` has `--resume <sid>` and the nudge, `resumed: true`); invalid twice → `handoff_invalid`, nothing posted; dirty after run → `worktree_dirty`; dirty before → no launch; no `implement.json` → `no_pr`; timeout → killed; failed Stop → `run_failed`; round defaults to sidecar + 1 |
| `tests/cli.test.ts` | `handoff check good` → 0; `no_pr --json` → 1 with problems; missing arg → 2 |
| `tests/plugin.test.ts` | skill registered; frontmatter; env vars named; headings and labels present; implement §6 has both markers |
| `tests/handoff.live.test.ts` | `skipIf(!MARSHALL_LIVE || !MARSHALL_LIVE_HANDOFF_CWD)`: real `claude` + `gh`, `writeHandoff` against the CHE-5 worktree, asserts ok, valid, under 10 min; no posting |

## Commits (each green: `bun test`, `bun run lint`, `bun run typecheck`, `bun run check:size`)

1. Extract markdown section helpers into `src/markdown.ts`; `template.ts` re-exports.
2. Add hand-off paths and config keys (`handoffPath`, `handoffMetaPath`, `handoffMinutes`, `models.handoff`, `handoffModel`).
3. Linear: `comment()` returns the comment id; add `updateComment`.
4. Add `src/gh.ts` and the `fake-gh` shim.
5. Hand-off validate + plugin template + `marshall handoff check`.
6. Hand-off PR-body splice and render.
7. Hand-off post: Linear comment, sidecar, PR body.
8. `runHandoffPhase`: launch, verify, validate, resume once, post.
9. Ship `/marshall:handoff`; wrap the implement skill's placeholder in markers; plugin tests and README row.
10. Dev launcher and gated live test.
11. Record the CHE-5 hand-off run under `docs/examples/step06_CHE-5/`; write `docs/handoff.md` and `docs/handoff_template.md`; update step 06 (naming fixes + today's decisions table), step 08 line 34 (`runHandoffPhase`; `postHandoff({ badge })` for the rebase re-post; follow-ups are filed after the hand-off, so the package lists titles), `plugin/README.md`, `README.md`, `docs/runner.md` (one line on `src/gh.ts`).

## Verification

- Unit: the matrix above; all green locally and in CI.
- Live, in the ChessBuddy CHE-5 worktree (branch `jacques/che-5-health-endpoint-reports-the-api-version`; create one with `git worktree add` if the step 05 one is gone; `gh auth status` green):
  1. `bun scripts/launch-handoff.ts --cwd <wt> --plan docs/health_version_plan.md --issue CHE-5 --post` → Linear comment on CHE-5 shows the six sections; PR #36 body has one `## Hand-off` section between the markers; `Closes <URL>` intact; `~/.marshall/handoffs/CHE-5.{md,json}` exist.
  2. Run it again with `--post --badge "rebased after https://github.com/dvairus/ChessBuddy/pull/1"` → same Linear comment edited (no second comment), PR body still has one section with the badge line, `gh pr view --json body` outside the markers byte-identical.
  3. `bin/marshall handoff check ~/.marshall/handoffs/CHE-5.md` → exit 0.
  4. Read section 2 of the result cold: can a reader find `GET /health` from it alone? Record the wall clock in the example README.
- Kill any process the live run leaves behind before reporting done.

## Risks

- **UUID vs identifier.** Linear calls take `issue.id`; paths and `implement.json` take `issue.identifier`. `PostInput.issue` requires both.
- **Linear footer.** Both `comment()` and `updateComment()` append `_— Marshall_`; the "same text" test strips it before comparing.
- **Deleted Linear comment.** `updateComment` fails → `linear_failed`; recovery is deleting the sidecar. Fallback-to-create is a later refinement.
- **Resume needs `sessionId`.** It arrives from the Stop hook payload; the `stop-empty` fixture carries one.
- **Worktree cleanliness.** The skill writes only under `handoffs/` and `$MARSHALL_ISSUE_DIR`; `writePrBody`'s temp file lives in `issueDir`, never in `cwd`.
- **Live run side effects.** Step 11 posts a real comment on CHE-5 and edits the real body of PR #36. That is the intended example, but it is outward-facing.
- **Zod 4 `.default()`** on a transformed schema would drop `handoff`; `handoffModel()` avoids it.
- **`noUncheckedIndexedAccess`** hotspots: regex groups, `lines[i]`, `indexOf` results, `argv[++i]`, `gitLines(...)[0]`.
