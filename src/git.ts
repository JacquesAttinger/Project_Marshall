// Last edited: 2026-09-20 10:55 CDT
// The one place that spawns `git`. Small on purpose: callers pass argv and get stdout back.

export class GitError extends Error {
  override name = "GitError";
}

/**
 * Repo-location variables a git hook exports to its children. Left in place, every git call in a
 * child process acts on the hook's repo instead of its own cwd. The pre-commit run of the test
 * suite proved it: the fake planner's `git commit` landed on Marshall's own branch.
 */
export const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
];

export function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !GIT_LOCATION_VARS.includes(k)) env[k] = v;
  }
  return env;
}

/** Run `git <args>` in `cwd` and return stdout without the trailing newline. Non-zero exit → GitError. */
export async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new GitError(`git ${args.join(" ")} exited ${code}: ${stderr.trim().slice(0, 500)}`);
  }
  return stdout.replace(/\n+$/, "");
}

/** Lines of `git <args>` output, untrimmed (porcelain status columns matter), blanks dropped. */
export async function gitLines(args: string[], cwd: string): Promise<string[]> {
  const out = await runGit(args, cwd);
  return out.split("\n").filter((l) => l.trim().length > 0);
}
