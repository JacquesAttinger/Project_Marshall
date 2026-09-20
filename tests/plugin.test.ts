// Last edited: 2026-09-20 11:15 CDT
// The plugin is what the agents load with --plugin-dir; a broken manifest or a skill without
// frontmatter fails silently inside an agent, so these checks run here instead.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PLUGIN_ROOT = resolve(import.meta.dir, "..", "plugin");
const SKILLS_DIR = join(PLUGIN_ROOT, "skills");

/** The skills the rest of Marshall refers to by name. Add here when a step adds one. */
const REQUIRED_SKILLS = ["implement", "review"];

function frontmatter(path: string): Record<string, string> {
  const text = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${path} has no frontmatter block`);
  const fields: Record<string, string> = {};
  for (const line of (match[1] as string).split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fields;
}

describe("plugin manifest", () => {
  test("parses and is named marshall", () => {
    const manifest = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("marshall");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof manifest.description).toBe("string");
  });

  test("the plugin root has no bin/ (it would land on the agent's PATH)", () => {
    expect(existsSync(join(PLUGIN_ROOT, "bin"))).toBe(false);
  });
});

describe("skills", () => {
  test("every required skill exists", () => {
    for (const name of REQUIRED_SKILLS) {
      expect(existsSync(join(SKILLS_DIR, name, "SKILL.md"))).toBe(true);
    }
  });

  test("every SKILL.md has a name that matches its folder and a description", () => {
    for (const dir of readdirSync(SKILLS_DIR)) {
      const fields = frontmatter(join(SKILLS_DIR, dir, "SKILL.md"));
      expect(fields.name).toBe(dir);
      expect(fields.description?.length ?? 0).toBeGreaterThan(20);
    }
  });

  test("implement is hidden from the model and takes plan path + issue id", () => {
    const fields = frontmatter(join(SKILLS_DIR, "implement", "SKILL.md"));
    expect(fields["disable-model-invocation"]).toBe("true");
    expect(fields["argument-hint"]).toBe("<plan-path> <ISSUE-ID>");
  });

  test("implement quotes every implement.json field the schema requires", async () => {
    const { ImplementStatusSchema } = await import("../src/implement/status.ts");
    const text = readFileSync(join(SKILLS_DIR, "implement", "SKILL.md"), "utf8");
    for (const key of Object.keys(ImplementStatusSchema.shape)) {
      expect(text).toContain(`"${key}"`);
    }
  });

  test("implement names the env vars the runner sets", () => {
    const text = readFileSync(join(SKILLS_DIR, "implement", "SKILL.md"), "utf8");
    for (const name of [
      "MARSHALL_ISSUE_DIR",
      "MARSHALL_ISSUE_URL",
      "MARSHALL_SLOT",
      "MARSHALL_MAX_CYCLES",
      "COMPOSE_PROJECT_NAME",
    ]) {
      expect(text).toContain(name);
    }
  });
});
