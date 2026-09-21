// Last edited: 2026-09-20 22:40 CDT

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BUSY_TIMEOUT_MS,
  counts,
  listMigrations,
  migrate,
  openDb,
  schemaVersion,
} from "../src/db/index.ts";
import { dbPath, ensureHome } from "../src/paths.ts";
import { type TempHome, useTempHome } from "./helpers.ts";

let home: TempHome;
let db: Database;

beforeEach(() => {
  home = useTempHome();
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
  home.restore();
});

function tables(d: Database): string[] {
  return d
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

const NOW = "2026-09-19T21:00:00.000Z";

function insertClaim(d: Database, issueId: string, slot: number, state: string): void {
  d.run(
    `INSERT INTO claims (issue_id, agent_id, slot, state, claimed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [issueId, `agent-${slot}`, slot, state, NOW, NOW],
  );
}

describe("openDb", () => {
  test("a second process's write waits for the first writer instead of failing at once", async () => {
    ensureHome();
    const path = dbPath();
    const a = openDb(path);
    migrate(a);
    a.close();
    const marker = join(home.dir, "locked");
    // A separate process holds a write lock for 300 ms; a timer in this thread could not, because
    // the blocked write below would stop the event loop.
    const holder = Bun.spawn(
      [
        "bun",
        "-e",
        `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(path)});
         db.run("BEGIN IMMEDIATE"); require("fs").writeFileSync(${JSON.stringify(marker)}, "");
         Bun.sleepSync(300); db.run("COMMIT"); db.close();`,
      ],
      { stdout: "ignore", stderr: "inherit" },
    );
    while (!existsSync(marker)) await Bun.sleep(10);
    const b = openDb(path);
    try {
      expect(b.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(
        BUSY_TIMEOUT_MS,
      );
      const started = Date.now();
      insertClaim(b, "CB-2", 1, "queued"); // throws SQLITE_BUSY at once without the timeout
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      expect(counts(b).claims).toBe(1);
    } finally {
      b.close();
      await holder.exited;
    }
  });
});

describe("migrate", () => {
  test("fresh DB starts at version 0 with zero counts", () => {
    expect(schemaVersion(db)).toBe(0);
    expect(counts(db)).toEqual({ claims: 0, starts: 0, events: 0, runs: 0 });
  });

  test("creates the five tables and sets user_version = 4", () => {
    const applied = migrate(db);
    expect(applied.map((m) => m.name)).toEqual([
      "001_init.sql",
      "002_runs.sql",
      "003_flags.sql",
      "004_master.sql",
    ]);
    expect(tables(db)).toEqual(["claims", "events", "flags", "runs", "starts"]);
    expect(schemaVersion(db)).toBe(4);
    expect(counts(db)).toEqual({ claims: 0, starts: 0, events: 0, runs: 0 });
  });

  test("second migrate applies nothing", () => {
    migrate(db);
    expect(migrate(db)).toHaveLength(0);
    expect(schemaVersion(db)).toBe(4);
  });

  test("listMigrations is sorted by number", () => {
    const versions = listMigrations().map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(versions[0]).toBe(1);
  });
});

describe("claims slot index", () => {
  beforeEach(() => {
    migrate(db);
  });

  test("two live claims on the same slot throw", () => {
    insertClaim(db, "CB-1", 0, "implementing");
    expect(() => insertClaim(db, "CB-2", 0, "planning")).toThrow(/UNIQUE/);
  });

  test("a released claim frees the slot", () => {
    insertClaim(db, "CB-1", 0, "released");
    insertClaim(db, "CB-2", 0, "planning");
    expect(counts(db).claims).toBe(2);
  });

  test("an awaiting_human claim frees the slot but keeps its row", () => {
    insertClaim(db, "CB-1", 0, "awaiting_human");
    insertClaim(db, "CB-2", 0, "planning");
    expect(counts(db).claims).toBe(2);
  });

  test("a rebasing claim frees the slot; a resolving one holds it", () => {
    insertClaim(db, "CB-1", 0, "rebasing");
    insertClaim(db, "CB-2", 0, "resolving");
    expect(() => insertClaim(db, "CB-3", 0, "planning")).toThrow(/UNIQUE/);
  });

  test("a blocked claim frees the slot", () => {
    insertClaim(db, "CB-1", 1, "blocked");
    insertClaim(db, "CB-2", 1, "claimed");
    expect(counts(db).claims).toBe(2);
  });

  test("slot outside 0-2 is rejected", () => {
    expect(() => insertClaim(db, "CB-1", 3, "claimed")).toThrow(/CHECK/);
  });

  test("duplicate issue_id is rejected", () => {
    insertClaim(db, "CB-1", 0, "claimed");
    expect(() => insertClaim(db, "CB-1", 1, "claimed")).toThrow(/UNIQUE/);
  });
});

describe("openDb", () => {
  test("creates the file at dbPath() under MARSHALL_HOME", () => {
    ensureHome();
    const fileDb = openDb();
    try {
      expect(existsSync(dbPath())).toBe(true);
      expect(dbPath().startsWith(home.dir)).toBe(true);
      expect(fileDb.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
    } finally {
      fileDb.close();
    }
  });
});
