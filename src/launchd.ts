// Last edited: 2026-09-21 00:40 CDT
// The launchd side of the daemon: the plist location, `launchctl print` parsed into a status, and
// the bootstrap/bootout wrappers `marshall start` / `stop` call. Every `launchctl` call goes
// through an injectable runner so the tests (and CI on Linux) never touch launchd.

import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const LAUNCHD_LABEL = "com.jacques.marshall";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** `gui/<uid>/<label>`: the domain launchctl addresses a LaunchAgent by. */
export function serviceTarget(uid: number = userInfo().uid): string {
  return `gui/${uid}/${LAUNCHD_LABEL}`;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `launchctl <args>`. Injected so the tests pass a fake. */
export type LaunchctlRunner = (args: string[]) => Promise<CommandResult>;

export async function runLaunchctl(args: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(["launchctl", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export type DaemonState = "running" | "loaded" | "not_loaded" | "not_installed" | "unavailable";

export interface DaemonStatus {
  state: DaemonState;
  /** The daemon's pid while running. */
  pid: number | null;
  plistPath: string;
  plistExists: boolean;
  /** One line to print. */
  detail: string;
}

/** Pull `state = ...` and `pid = ...` out of `launchctl print` output. */
export function parseLaunchctlPrint(out: string): { state: string | null; pid: number | null } {
  const state = /^\s*state = (\S+)/m.exec(out)?.[1] ?? null;
  const pid = /^\s*pid = (\d+)/m.exec(out)?.[1];
  return { state, pid: pid ? Number(pid) : null };
}

export interface DaemonDeps {
  launchctl?: LaunchctlRunner;
  platform?: NodeJS.Platform;
  plist?: string;
}

export async function daemonStatus(deps: DaemonDeps = {}): Promise<DaemonStatus> {
  const plist = deps.plist ?? plistPath();
  const plistExists = existsSync(plist);
  const base = { pid: null, plistPath: plist, plistExists };
  if ((deps.platform ?? process.platform) !== "darwin") {
    return { ...base, state: "unavailable", detail: "launchd is macOS-only" };
  }
  if (!plistExists) {
    return {
      ...base,
      state: "not_installed",
      detail: `not installed (run scripts/install-launchd.sh); expected ${plist}`,
    };
  }
  const run = deps.launchctl ?? runLaunchctl;
  const result = await run(["print", serviceTarget()]);
  if (result.code !== 0) {
    return { ...base, state: "not_loaded", detail: "installed but not loaded (marshall start)" };
  }
  const { state, pid } = parseLaunchctlPrint(result.stdout);
  if (state === "running" && pid !== null) {
    return { ...base, state: "running", pid, detail: `running (pid ${pid})` };
  }
  return { ...base, state: "loaded", pid, detail: `loaded, ${state ?? "state unknown"}` };
}

/** `launchctl bootstrap`: load and, with RunAtLoad, start. Throws with launchctl's own words. */
export async function bootstrap(deps: DaemonDeps = {}): Promise<void> {
  const plist = deps.plist ?? plistPath();
  if (!existsSync(plist)) {
    throw new Error(
      `Marshall is not installed: ${plist} is missing. Run scripts/install-launchd.sh.`,
    );
  }
  const run = deps.launchctl ?? runLaunchctl;
  const result = await run(["bootstrap", `gui/${userInfo().uid}`, plist]);
  if (result.code !== 0) {
    const text = (result.stderr || result.stdout).trim();
    if (/already (loaded|bootstrapped)|(service|in) already/i.test(text) || result.code === 37) {
      return;
    }
    throw new Error(`launchctl bootstrap failed (${result.code}): ${text}`);
  }
}

/** `launchctl bootout`: stop and unload. A service that is not loaded is not an error. */
export async function bootout(deps: DaemonDeps = {}): Promise<boolean> {
  const run = deps.launchctl ?? runLaunchctl;
  const result = await run(["bootout", serviceTarget()]);
  if (result.code === 0) return true;
  const text = (result.stderr || result.stdout).trim();
  if (/no such process|not find|could not find|not loaded/i.test(text) || result.code === 3) {
    return false;
  }
  throw new Error(`launchctl bootout failed (${result.code}): ${text}`);
}
