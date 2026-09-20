// Last edited: 2026-09-20 11:40 CDT
// Runner test setup: temp MARSHALL_HOME, temp CLAUDE_CONFIG_DIR seeded with fixture jobs,
// a migrated in-memory DB, and MARSHALL_CLAUDE_BIN pointed at the fake shim.

import type { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate, openDb } from "../../src/db/index.ts";
import { ensureHome } from "../../src/paths.ts";
import { type TempHome, useTempHome } from "../helpers.ts";

const FIXTURES = resolve(import.meta.dir, "..", "fixtures");
export const FAKE_CLAUDE = join(FIXTURES, "fake-claude");

export interface RunnerEnv {
  home: TempHome;
  claudeDir: string;
  fakeDir: string;
  db: Database;
  restore(): void;
}

const ENV_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "MARSHALL_CLAUDE_BIN",
  "FAKE_CLAUDE_DIR",
  "FAKE_CLAUDE_FAIL",
  "FAKE_CLAUDE_PLAN_SCRIPT",
];

export function useRunnerEnv(): RunnerEnv {
  const previous = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const home = useTempHome("marshall-runner-");
  ensureHome();
  const claudeDir = mkdtempSync(join(tmpdir(), "marshall-claude-"));
  mkdirSync(join(claudeDir, "jobs"), { recursive: true });
  cpSync(join(FIXTURES, "jobs"), join(claudeDir, "jobs"), { recursive: true });
  const fakeDir = mkdtempSync(join(tmpdir(), "marshall-fake-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.MARSHALL_CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_DIR = fakeDir;
  delete process.env.FAKE_CLAUDE_FAIL;
  delete process.env.FAKE_CLAUDE_PLAN_SCRIPT;
  const db = openDb(":memory:");
  migrate(db);
  return {
    home,
    claudeDir,
    fakeDir,
    db,
    restore() {
      db.close();
      for (const [k, v] of previous) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(claudeDir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
      home.restore();
    },
  };
}

/** The argv of every fake-claude call, in order. */
export function fakeCalls(env: RunnerEnv): string[][] {
  const path = join(env.fakeDir, "calls.log");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("--\n")
    .filter((block) => block.trim().length > 0)
    .map((block) =>
      block
        .split("\n")
        .filter((l) => l.startsWith("arg="))
        .map((l) => l.slice("arg=".length)),
    );
}

/** Ids passed to `fake-claude stop`, in order. */
export function fakeStops(env: RunnerEnv): string[] {
  try {
    return readFileSync(join(env.fakeDir, "stops.log"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

/** Canned output for `fake-claude agents --json --all`. */
export function setFakeAgents(env: RunnerEnv, agents: Record<string, unknown>[]): void {
  Bun.write(join(env.fakeDir, "agents.json"), JSON.stringify(agents));
}

export function setFakeNextId(env: RunnerEnv, id: string): void {
  Bun.write(join(env.fakeDir, "next-id"), id);
}

/** Canned stdout for `fake-claude -p ...`. A string is written as-is; an object is JSON-encoded. */
export function setFakePrint(env: RunnerEnv, output: string | Record<string, unknown>): void {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  writeFileSync(join(env.fakeDir, "print.json"), text);
}

/** Read a hook fixture payload by name (`stop-empty`, `stop-failure-rate-limit`, ...). */
export function hookFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, "hooks", `${name}.json`), "utf8"));
}
