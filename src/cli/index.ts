// Last edited: 2026-09-19 22:30 CDT
// Hand-rolled dispatch. No CLI dependency. `bin/marshall` imports this file.

import { runMigrate } from "./db.ts";
import { runLinearSetup } from "./linear.ts";
import { runStatus } from "./status.ts";

const USAGE = `Usage: marshall <command> [options]

Commands:
  status [--json]     Print config, state dir, schema version, and row counts
  db migrate          Create the state dir and apply pending migrations
  linear setup [--json]
                      Create the Needs Verification state and the marshall labels (idempotent)

Options:
  --config <path>     Config file (default: MARSHALL_CONFIG or ./marshall.config.json)
  -h, --help          Show this help`;

interface Parsed {
  positional: string[];
  json: boolean;
  help: boolean;
  configPath?: string;
}

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { positional: [], json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--config") {
      const next = argv[++i];
      if (!next) throw new Error("--config needs a path");
      out.configPath = next;
    } else if (a.startsWith("--config=")) out.configPath = a.slice("--config=".length);
    else if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
    else out.positional.push(a);
  }
  return out;
}

type Command = (args: Parsed) => void | Promise<void>;

/** Keyed by the joined positionals: "status", "db migrate", "linear setup". */
const COMMANDS: Record<string, Command> = {
  status: (args) => runStatus({ json: args.json, configPath: args.configPath }),
  "db migrate": () => runMigrate(),
  "linear setup": (args) => runLinearSetup({ json: args.json, configPath: args.configPath }),
};

/** Returns the process exit code. Throws only on unexpected errors. */
export async function dispatch(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help || args.positional.length === 0) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  const command = COMMANDS[args.positional.join(" ")];
  if (!command) {
    console.error(`Unknown command: ${args.positional.join(" ")}\n`);
    console.error(USAGE);
    return 2;
  }
  await command(args);
  return 0;
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
