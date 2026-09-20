// Last edited: 2026-09-20 17:00 CDT
// Hand-rolled dispatch. No CLI dependency. `bin/marshall` imports this file.

import { runMigrate } from "./db.ts";
import { runLinearSetup } from "./linear.ts";
import { runPlan, runPlanCheck } from "./plan.ts";
import { runQueue } from "./queue.ts";
import { runStatus } from "./status.ts";

const USAGE = `Usage: marshall <command> [options]

Commands:
  status [--json]     Print config, state dir, schema version, and row counts
  db migrate          Create the state dir and apply pending migrations
  linear setup [--json]
                      Create the Needs Verification and Blocked states and the marshall labels
  plan <identifier> --cwd <worktree> [--revise] [--json]
                      Run the planning phase on one issue in an existing worktree
  plan check <file> [--json]
                      Check a plan file for the required sections
  queue [--json]      Dry-run one scheduler tick: the ordered pickable list and why each
                      issue would or would not start now. Never writes.

Options:
  --config <path>     Config file (default: MARSHALL_CONFIG or ./marshall.config.json)
  --cwd <path>        Worktree the planner runs in (plan only)
  --revise            Revise an existing plan after a bounce (plan only)
  -h, --help          Show this help`;

interface Parsed {
  positional: string[];
  json: boolean;
  help: boolean;
  revise: boolean;
  configPath?: string;
  cwd?: string;
}

/** Options that take a value: `--name value` or `--name=value`. */
const VALUE_OPTIONS: Record<string, keyof Pick<Parsed, "configPath" | "cwd">> = {
  "--config": "configPath",
  "--cwd": "cwd",
};

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { positional: [], json: false, help: false, revise: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const [flag, inline] = a.includes("=")
      ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
      : [a, undefined];
    const key = VALUE_OPTIONS[flag];
    if (key) {
      const value = inline ?? argv[++i];
      if (!value) throw new Error(`${flag} needs a path`);
      out[key] = value;
    } else if (a === "--json") out.json = true;
    else if (a === "--revise") out.revise = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
    else out.positional.push(a);
  }
  return out;
}

/** A command returns its exit code, or nothing for 0. */
type CommandResult = number | undefined;

interface Command {
  /** How many positionals follow the command words. */
  arity: number;
  run: (args: Parsed, rest: string[]) => CommandResult | Promise<CommandResult>;
}

/** Keyed by the command words. The longest key that prefixes the positionals wins. */
const COMMANDS: Record<string, Command> = {
  status: {
    arity: 0,
    run: (args) => void runStatus({ json: args.json, configPath: args.configPath }),
  },
  "db migrate": { arity: 0, run: () => void runMigrate() },
  "linear setup": {
    arity: 0,
    run: async (args) =>
      void (await runLinearSetup({ json: args.json, configPath: args.configPath })),
  },
  "plan check": { arity: 1, run: (args, [file]) => runPlanCheck(file as string, args.json) },
  queue: {
    arity: 0,
    run: async (args) => void (await runQueue({ json: args.json, configPath: args.configPath })),
  },
  plan: {
    arity: 1,
    run: (args, [identifier]) =>
      runPlan({
        identifier: identifier as string,
        cwd: args.cwd,
        revise: args.revise,
        json: args.json,
        configPath: args.configPath,
      }),
  },
};

function findCommand(positional: string[]): { command: Command; rest: string[] } | null {
  for (let n = Math.min(positional.length, 2); n >= 1; n--) {
    const command = COMMANDS[positional.slice(0, n).join(" ")];
    if (command) return { command, rest: positional.slice(n) };
  }
  return null;
}

/** Returns the process exit code. Throws only on unexpected errors. */
export async function dispatch(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help || args.positional.length === 0) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  const found = findCommand(args.positional);
  if (!found || found.rest.length !== found.command.arity) {
    console.error(`Unknown command: ${args.positional.join(" ")}\n`);
    console.error(USAGE);
    return 2;
  }
  return (await found.command.run(args, found.rest)) ?? 0;
}

/** Entry point used by bin/marshall. Exits the process. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<never> {
  try {
    process.exit(await dispatch(argv));
  } catch (err) {
    console.error(`marshall: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
