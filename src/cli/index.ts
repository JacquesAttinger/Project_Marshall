// Last edited: 2026-09-19 21:28 CDT
// Hand-rolled dispatch. No CLI dependency. `bin/marshall` imports this file.

import { runMigrate } from "./db.ts";
import { runStatus } from "./status.ts";

const USAGE = `Usage: marshall <command> [options]

Commands:
  status [--json]     Print config, state dir, schema version, and row counts
  db migrate          Create the state dir and apply pending migrations

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

/** Returns the process exit code. Throws only on unexpected errors. */
export function dispatch(argv: string[]): number {
  const args = parseArgs(argv);
  const [cmd, sub] = args.positional;
  if (args.help || !cmd) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  if (cmd === "status" && !sub) {
    runStatus({ json: args.json, configPath: args.configPath });
    return 0;
  }
  if (cmd === "db" && sub === "migrate") {
    runMigrate();
    return 0;
  }
  console.error(`Unknown command: ${args.positional.join(" ")}\n`);
  console.error(USAGE);
  return 2;
}

/** Entry point used by bin/marshall. Exits the process. */
export function main(argv: string[] = process.argv.slice(2)): never {
  try {
    process.exit(dispatch(argv));
  } catch (err) {
    console.error(`marshall: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) main();
