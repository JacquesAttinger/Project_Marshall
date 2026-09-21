// Last edited: 2026-09-21 01:00 CDT
// `marshall start` / `marshall stop`: launchctl bootstrap and bootout of the LaunchAgent that
// scripts/install-launchd.sh installed. A reboot re-loads the plist on its own (RunAtLoad), so
// `stop` is for the current session only.

import { bootout, bootstrap, type DaemonDeps, daemonStatus } from "../launchd.ts";

export async function runStart(deps: DaemonDeps = {}): Promise<number> {
  const before = await daemonStatus(deps);
  if (before.state === "unavailable") {
    console.error(`marshall start: ${before.detail}; run \`marshall run\` in a terminal instead`);
    return 1;
  }
  if (before.state === "running") {
    console.log(`marshall: already ${before.detail}`);
    return 0;
  }
  await bootstrap(deps);
  const after = await daemonStatus(deps);
  console.log(`marshall: ${after.detail}`);
  return after.state === "running" || after.state === "loaded" ? 0 : 1;
}

export async function runStop(deps: DaemonDeps = {}): Promise<number> {
  const before = await daemonStatus(deps);
  if (before.state === "unavailable" || before.state === "not_installed") {
    console.error(`marshall stop: ${before.detail}`);
    return 1;
  }
  const stopped = await bootout(deps);
  console.log(
    stopped
      ? "marshall: stopped. Live agents keep their jobs; the next start reconciles them."
      : "marshall: was not running",
  );
  return 0;
}
