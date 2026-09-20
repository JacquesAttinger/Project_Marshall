// Last edited: 2026-09-20 12:25 CDT
// SQLite via bun:sqlite. Numbered SQL migrations tracked with PRAGMA user_version.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dbPath } from "../paths.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface Counts {
  claims: number;
  starts: number;
  events: number;
  runs: number;
}

/** How long a writer waits for another process's lock before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * Open (or create) the database with WAL, foreign keys, and a busy timeout on. `:memory:` works
 * for tests. The timeout matters because more than one Marshall process can hold the file
 * (a launcher's watcher plus `marshall status`, or two launchers): without it the second writer
 * fails at once instead of waiting for the other's transaction to finish.
 */
export function openDb(path: string = dbPath()): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

export function schemaVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

/** Every `NNN_name.sql` in the migrations dir, sorted by number. */
export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .map((f) => ({
      version: Number.parseInt(f.slice(0, 3), 10),
      name: f,
      sql: readFileSync(join(dir, f), "utf8"),
    }))
    .sort((a, b) => a.version - b.version);
}

/** Apply every migration above the current user_version, one transaction each. */
export function migrate(db: Database, dir: string = MIGRATIONS_DIR): Migration[] {
  const applied: Migration[] = [];
  for (const m of listMigrations(dir)) {
    if (m.version <= schemaVersion(db)) continue;
    db.transaction(() => {
      db.run(m.sql);
      db.run(`PRAGMA user_version = ${m.version}`);
    })();
    applied.push(m);
  }
  return applied;
}

function countRows(db: Database, table: string): number {
  try {
    const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return row?.n ?? 0;
  } catch {
    // Table does not exist yet (schema version 0).
    return 0;
  }
}

export function counts(db: Database): Counts {
  return {
    claims: countRows(db, "claims"),
    starts: countRows(db, "starts"),
    events: countRows(db, "events"),
    runs: countRows(db, "runs"),
  };
}
