// Last edited: 2026-09-20 17:10 CDT
// Dev launcher for one `/marshall:handoff` run, until step 08's orchestrator exists.
//
//   bun scripts/launch-handoff.ts --cwd <worktree> --plan docs/x_plan.md --issue CB-12
//     [--round N] [--model opus] [--post] [--badge "rebased after <PR URL>"] [--issue-url <url>]
//   bun scripts/launch-handoff.ts --issue CB-12 --cwd <worktree> --post-only [--round N] [--badge "…"]
//
// Runs the writer and waits for its Stop (writeHandoff always waits). With --post the package also
// goes to Linear and the PR body, which needs MARSHALL_LINEAR_API_KEY. --post-only skips the writer
// and re-posts the file that is already at ~/.marshall/handoffs/<ISSUE-ID>.md (the rebase re-post).

import { resolve } from "node:path";
import { loadConfig, loadEnv, requireLinearApiKey } from "../src/config.ts";
import { migrate, openDb } from "../src/db/index.ts";
import { readHandoffMeta } from "../src/handoff/meta.ts";
import { runHandoffPhase, writeHandoff } from "../src/handoff/phase.ts";
import { postHandoff } from "../src/handoff/post.ts";
import { readImplementStatus } from "../src/implement/status.ts";
import { connectLinear, type IssueDetail } from "../src/linear/index.ts";
import { createLogger } from "../src/log.ts";
import { ensureHome } from "../src/paths.ts";
import { createRunWaiter } from "../src/plan/wait.ts";

interface Args {
  cwd: string;
  plan: string;
  issue: string;
  round?: number;
  model?: string;
  post: boolean;
  postOnly: boolean;
  badge?: string;
  issueUrl?: string;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    "Usage: bun scripts/launch-handoff.ts --cwd <worktree> --plan <path> --issue <ID>" +
      ' [--round N] [--model opus] [--post] [--badge "..."] [--issue-url <url>]\n' +
      '       bun scripts/launch-handoff.ts --cwd <worktree> --issue <ID> --post-only [--round N] [--badge "..."]',
  );
  process.exit(2);
}

export function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--post" || a === "--post-only") flags.add(a);
    else if (a.startsWith("--")) {
      const next = argv[++i];
      if (next === undefined) usage(`${a} needs a value`);
      values[a.slice(2)] = next;
    } else usage(`Unexpected argument: ${a}`);
  }
  const postOnly = flags.has("--post-only");
  for (const key of postOnly ? ["cwd", "issue"] : ["cwd", "plan", "issue"]) {
    if (!values[key]) usage(`--${key} is required`);
  }
  const round = values.round === undefined ? undefined : Number(values.round);
  if (round !== undefined && (!Number.isInteger(round) || round < 1)) {
    usage("--round must be a positive integer");
  }
  return {
    cwd: resolve(values.cwd as string),
    plan: values.plan ?? "",
    issue: values.issue as string,
    round,
    model: values.model,
    post: flags.has("--post") || postOnly,
    postOnly,
    badge: values.badge,
    issueUrl: values["issue-url"],
  };
}

/** An IssueDetail with only what the writer reads (identifier, url); no Linear round trip. */
function localIssue(identifier: string, url: string): IssueDetail {
  return {
    id: identifier,
    identifier,
    title: identifier,
    description: null,
    priority: 0,
    url,
    branchName: "",
    createdAt: new Date().toISOString(),
    labels: [],
    comments: [],
    state: { name: "In Progress", type: "started" },
    agentId: null,
    latestHumanComment: null,
    relatedIssueIds: [],
  };
}

type Linear = Awaited<ReturnType<typeof connectLinear>>;

/** `--post-only`: re-post the file already at handoffs/<ID>.md, with an optional badge. */
async function postOnly(args: Args, issue: IssueDetail, linear: Linear): Promise<number> {
  const status = readImplementStatus(args.issue);
  if (!status?.prUrl) throw new Error(`no prUrl in implement.json for ${args.issue}`);
  const round = args.round ?? readHandoffMeta(args.issue)?.round ?? 1;
  const result = await postHandoff({
    issue,
    linear,
    prUrl: status.prUrl,
    cwd: args.cwd,
    round,
    badge: args.badge,
  });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

/** Run the writer; with Linear also post (through runHandoffPhase, or postHandoff for a badge). */
async function writeAndMaybePost(
  args: Args,
  issue: IssueDetail,
  linear: Linear | null,
): Promise<number> {
  const config = loadConfig();
  const db = openDb();
  migrate(db);
  const waiter = createRunWaiter(db);
  const common = {
    db,
    config,
    issue,
    cwd: args.cwd,
    planPath: args.plan,
    round: args.round,
    model: args.model,
    waiter,
    onLaunched: (run: { runId: string; jobId: string | null }) =>
      console.log(`run ${run.runId} job ${run.jobId} cwd ${args.cwd}`),
  };
  try {
    if (linear && args.badge) {
      const written = await writeHandoff(common);
      if (!written.ok) throw new Error(`${written.reason}: ${written.detail}`);
      const posted = await postHandoff({
        issue,
        linear,
        prUrl: written.prUrl,
        cwd: args.cwd,
        round: written.round,
        badge: args.badge,
      });
      console.log(JSON.stringify({ written, posted }, null, 2));
      return posted.ok ? 0 : 1;
    }
    const result = linear
      ? await runHandoffPhase({ ...common, linear })
      : await writeHandoff(common);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  } finally {
    waiter.stop();
    db.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const log = createLogger({ command: "launch-handoff", issue: args.issue });
  ensureHome();
  const linear = args.post
    ? await connectLinear({
        apiKey: requireLinearApiKey(loadEnv()),
        teamId: config.teamId,
        workspace: config.workspace,
        log,
      })
    : null;
  const issue = linear
    ? await linear.getIssue(args.issue)
    : localIssue(
        args.issue,
        args.issueUrl ?? `https://linear.app/${config.workspace}/issue/${args.issue}`,
      );
  const started = Date.now();
  process.exitCode =
    args.postOnly && linear
      ? await postOnly(args, issue, linear)
      : await writeAndMaybePost(args, issue, linear);
  console.log(`wall clock: ${Math.round((Date.now() - started) / 1000)} s`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
