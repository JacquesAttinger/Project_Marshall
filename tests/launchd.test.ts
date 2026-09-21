// Last edited: 2026-09-21 00:45 CDT
// launchd wrappers with a fake launchctl: status parsing, the missing-plist paths, and the
// bootstrap/bootout error handling. Also renders the plist template the way install-launchd.sh does
// and checks the fields the runbook promises.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bootout,
  bootstrap,
  type CommandResult,
  daemonStatus,
  LAUNCHD_LABEL,
  type LaunchctlRunner,
  parseLaunchctlPrint,
  plistPath,
  serviceTarget,
} from "../src/launchd.ts";

const PRINT_RUNNING = `gui/501/com.jacques.marshall = {
\tactive count = 1
\tpath = /Users/j/Library/LaunchAgents/com.jacques.marshall.plist
\tstate = running
\tpid = 4242

\tprogram = /bin/zsh
}`;

const PRINT_STOPPED = PRINT_RUNNING.replace("state = running\n\tpid = 4242", "state = not running");

function fakeLaunchctl(answers: Record<string, CommandResult>) {
  const calls: string[][] = [];
  const run: LaunchctlRunner = async (args) => {
    calls.push(args);
    return answers[args[0] as string] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

let dir: string;
let plist: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marshall-launchd-"));
  plist = join(dir, `${LAUNCHD_LABEL}.plist`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseLaunchctlPrint", () => {
  test("reads state and pid", () => {
    expect(parseLaunchctlPrint(PRINT_RUNNING)).toEqual({ state: "running", pid: 4242 });
    expect(parseLaunchctlPrint(PRINT_STOPPED)).toEqual({ state: "not", pid: null });
    expect(parseLaunchctlPrint("")).toEqual({ state: null, pid: null });
  });

  test("paths and targets", () => {
    expect(plistPath().endsWith(`/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`)).toBe(true);
    expect(serviceTarget(501)).toBe("gui/501/com.jacques.marshall");
  });
});

describe("daemonStatus", () => {
  test("not macOS → unavailable, without calling launchctl", async () => {
    const f = fakeLaunchctl({});
    const s = await daemonStatus({ launchctl: f.run, platform: "linux", plist });
    expect(s.state).toBe("unavailable");
    expect(f.calls).toHaveLength(0);
  });

  test("no plist → not_installed, without calling launchctl", async () => {
    const f = fakeLaunchctl({});
    const s = await daemonStatus({ launchctl: f.run, platform: "darwin", plist });
    expect(s).toMatchObject({ state: "not_installed", plistExists: false, pid: null });
    expect(s.detail).toContain("install-launchd.sh");
    expect(f.calls).toHaveLength(0);
  });

  test("plist present: print failing → not_loaded; running → pid; else loaded", async () => {
    writeFileSync(plist, "<plist/>");
    const notLoaded = fakeLaunchctl({ print: { code: 113, stdout: "", stderr: "Could not find" } });
    expect(
      (await daemonStatus({ launchctl: notLoaded.run, platform: "darwin", plist })).state,
    ).toBe("not_loaded");
    const running = fakeLaunchctl({ print: { code: 0, stdout: PRINT_RUNNING, stderr: "" } });
    const s = await daemonStatus({ launchctl: running.run, platform: "darwin", plist });
    expect(s).toMatchObject({ state: "running", pid: 4242, detail: "running (pid 4242)" });
    expect(running.calls[0]?.[0]).toBe("print");
    const loaded = fakeLaunchctl({ print: { code: 0, stdout: PRINT_STOPPED, stderr: "" } });
    expect((await daemonStatus({ launchctl: loaded.run, platform: "darwin", plist })).state).toBe(
      "loaded",
    );
  });
});

describe("bootstrap / bootout", () => {
  test("bootstrap without a plist names the install script and never calls launchctl", async () => {
    const f = fakeLaunchctl({});
    await expect(bootstrap({ launchctl: f.run, plist })).rejects.toThrow(/install-launchd\.sh/);
    expect(f.calls).toHaveLength(0);
  });

  test("bootstrap passes the plist; 'already loaded' is not an error; other failures throw", async () => {
    writeFileSync(plist, "<plist/>");
    const ok = fakeLaunchctl({});
    await bootstrap({ launchctl: ok.run, plist });
    expect(ok.calls[0]?.[0]).toBe("bootstrap");
    expect(ok.calls[0]?.[2]).toBe(plist);
    const already = fakeLaunchctl({
      bootstrap: {
        code: 37,
        stdout: "",
        stderr: "Bootstrap failed: 37: Operation already in progress",
      },
    });
    await bootstrap({ launchctl: already.run, plist });
    const bad = fakeLaunchctl({ bootstrap: { code: 5, stdout: "", stderr: "Input/output error" } });
    await expect(bootstrap({ launchctl: bad.run, plist })).rejects.toThrow(/Input\/output error/);
  });

  test("bootout returns true when it stopped something, false when nothing was loaded", async () => {
    const ok = fakeLaunchctl({});
    expect(await bootout({ launchctl: ok.run })).toBe(true);
    expect(ok.calls[0]).toEqual(["bootout", serviceTarget()]);
    const none = fakeLaunchctl({
      bootout: { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" },
    });
    expect(await bootout({ launchctl: none.run })).toBe(false);
    const bad = fakeLaunchctl({ bootout: { code: 1, stdout: "", stderr: "permission denied" } });
    await expect(bootout({ launchctl: bad.run })).rejects.toThrow(/permission denied/);
  });
});

describe("plist template", () => {
  test("renders with caffeinate, KeepAlive, RunAtLoad, the repo cwd, and the ~/.marshall logs", () => {
    const template = readFileSync(
      resolve(import.meta.dir, "..", "scripts", "launchd", `${LAUNCHD_LABEL}.plist.template`),
      "utf8",
    );
    const rendered = template
      .replaceAll("{{BUN}}", "/opt/homebrew/bin/bun")
      .replaceAll("{{REPO}}", "/Users/j/code/Project_Marshall")
      .replaceAll("{{HOME}}", "/Users/j");
    expect(rendered).not.toContain("{{");
    expect(rendered).toContain(
      "<string>exec /usr/bin/caffeinate -i /opt/homebrew/bin/bun /Users/j/code/Project_Marshall/bin/marshall run</string>",
    );
    expect(rendered).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(rendered).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(rendered).toContain("<string>/Users/j/code/Project_Marshall</string>");
    expect(rendered).toContain("<string>/Users/j/.marshall/logs/launchd.out.log</string>");
    expect(rendered).toContain("<string>/Users/j/.marshall/logs/launchd.err.log</string>");
    expect(rendered).toContain(`<string>${LAUNCHD_LABEL}</string>`);
  });
});
