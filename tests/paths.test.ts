// Last edited: 2026-09-20 10:56 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  briefsDir,
  claudeHome,
  claudeJobsDir,
  ensureHome,
  eventsDir,
  transcriptPath,
} from "../src/paths.ts";
import { type TempHome, useTempHome } from "./helpers.ts";

let home: TempHome;
let previousClaudeDir: string | undefined;

beforeEach(() => {
  home = useTempHome();
  previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
  home.restore();
});

describe("claudeHome", () => {
  test("defaults to ~/.claude", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeHome()).toBe(join(homedir(), ".claude"));
    expect(claudeJobsDir()).toBe(join(homedir(), ".claude", "jobs"));
  });

  test("honours CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = home.dir;
    expect(claudeHome()).toBe(home.dir);
    expect(claudeJobsDir()).toBe(join(home.dir, "jobs"));
  });
});

describe("transcriptPath", () => {
  test("slugs the cwd by replacing every non-alphanumeric character with -", () => {
    process.env.CLAUDE_CONFIG_DIR = "/cfg";
    expect(transcriptPath("/Users/me/code/Project_Marshall", "abc")).toBe(
      "/cfg/projects/-Users-me-code-Project-Marshall/abc.jsonl",
    );
  });

  test("resolves symlinks first, as Claude Code does (macOS /var → /private/var)", () => {
    process.env.CLAUDE_CONFIG_DIR = "/cfg";
    const real = join(home.dir, "real");
    const link = join(home.dir, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(transcriptPath(link, "abc")).toBe(transcriptPath(real, "abc"));
    expect(transcriptPath(link, "abc")).toContain(realpathSync(real).replace(/[^A-Za-z0-9]/g, "-"));
  });
});

describe("ensureHome", () => {
  test("creates the events and briefs dirs under MARSHALL_HOME", () => {
    ensureHome();
    expect(eventsDir()).toBe(join(home.dir, "events"));
    expect(existsSync(eventsDir())).toBe(true);
    expect(briefsDir()).toBe(join(home.dir, "briefs"));
    expect(existsSync(briefsDir())).toBe(true);
  });
});
