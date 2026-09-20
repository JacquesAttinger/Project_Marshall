// Last edited: 2026-09-20 10:35 CDT
// Typed loaders for marshall.config.json (committed) and process.env (from .env).

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { expandTilde } from "./paths.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
export const DEFAULT_CONFIG_PATH = resolve(REPO_ROOT, "marshall.config.json");

export class ConfigError extends Error {
  override name = "ConfigError";
}

const positiveInt = z.number().int().min(1);
const modelName = z.string().min(1);

/** Which Claude model each phase runs. Values go straight to `--model`. */
export const ModelsSchema = z
  .object({
    classifier: modelName.default("haiku"),
    planSimple: modelName.default("opus"),
    planComplex: modelName.default("fable"),
  })
  .strict();

export const ConfigSchema = z
  .object({
    workspace: z.string().min(1),
    teamId: z.string().min(1),
    repoPath: z
      .string()
      .min(1)
      .transform((p) => resolve(expandTilde(p)))
      .refine((p) => existsSync(p) && statSync(p).isDirectory(), {
        message: "must be an existing directory",
      }),
    baseBranch: z.string().min(1).default("main"),
    maxAgents: z.number().int().min(1).max(3).default(2),
    dailyStartCap: positiveInt.default(6),
    windowStartCap: positiveInt.default(2),
    windowHours: z.number().int().min(1).max(24).default(5),
    pollSeconds: z.number().int().min(10).max(600).default(45),
    stallMinutes: positiveInt.default(5),
    issueTimeoutHours: positiveInt.default(2),
    maxFixCycles: positiveInt.default(4),
    maxBounces: positiveInt.default(3),
    maxResumes: positiveInt.default(2),
    /** Planner wall clock, inside the issue clock. Step 08 kills the run on expiry. */
    planMinutes: positiveInt.default(20),
    models: ModelsSchema.default({ classifier: "haiku", planSimple: "opus", planComplex: "fable" }),
  })
  .strict();

export type Config = Readonly<z.infer<typeof ConfigSchema>>;

export const EnvSchema = z.object({
  // Not `LINEAR_API_KEY`: a shell that exports the Hemut key would win over `.env` under Bun.
  MARSHALL_LINEAR_API_KEY: z.string().optional(),
  NTFY_TOPIC_PREFIX: z.string().optional(),
});

export type Env = Readonly<z.infer<typeof EnvSchema>>;

/** The Linear key, or a ConfigError that says where to put it. */
export function requireLinearApiKey(env: Env): string {
  const key = env.MARSHALL_LINEAR_API_KEY;
  if (!key) {
    throw new ConfigError("MARSHALL_LINEAR_API_KEY is not set. Add it to .env (see .env.example).");
  }
  return key;
}

/** Resolve the config path: explicit arg > MARSHALL_CONFIG > <repo root>/marshall.config.json. */
export function resolveConfigPath(explicit?: string): string {
  const fromEnv = process.env.MARSHALL_CONFIG;
  const chosen = explicit ?? (fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_CONFIG_PATH);
  return resolve(expandTilde(chosen));
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

/** Validate an already-parsed object. Throws ConfigError naming the failing key. */
export function parseConfig(raw: unknown, source = "<inline>"): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid config at ${source}: ${formatIssues(result.error)}`);
  }
  return Object.freeze(result.data);
}

/** Read, parse, and validate the config file. Returns a frozen typed object. */
export function loadConfig(explicitPath?: string): Config {
  const path = resolveConfigPath(explicitPath);
  if (!existsSync(path)) {
    throw new ConfigError(`Config file not found: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`Config file is not valid JSON: ${path} (${(err as Error).message})`);
  }
  return parseConfig(raw, path);
}

/** Validate process.env. Bun loads `.env` before this runs. */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`Invalid environment: ${formatIssues(result.error)}`);
  }
  return Object.freeze(result.data);
}
