// Last edited: 2026-09-19 22:00 CDT

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { counts, listMigrations, migrate, openDb, schemaVersion } from "../src/db/index.ts";
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

describe("migrate", () => {
  test("fresh DB starts at version 0 with zero counts", () => {
    expect(schemaVersion(db)).toBe(0);
    expect(counts(db)).toEqual({ claims: 0, starts: 0, events: 0, runs: 0 });
  });

  test("creates the four tables and sets user_version = 2", () => {
    const applied = migrate(db);
    expect(applied.map((m) => m.name)).toEqual(["001_init.sql", "002_runs.sql"]);
    expect(tables(db)).toEqual(["claims", "events", "runs", "starts"]);
    expect(schemaVersion(db)).toBe(2);
    expect(counts(db)).toEqual({ claims: 0, starts: 0, events: 0, runs: 0 });
  });

  test("second migrate applies nothing", () => {
    migrate(db);
    expect(migrate(db)).toHaveLength(0);
    expect(schemaVersion(db)).toBe(2);
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
