// Last edited: 2026-09-19 21:28 CDT
// `marshall db migrate` — create the state dir and apply pending migrations.

import { migrate, openDb, schemaVersion } from "../db/index.ts";
import { dbPath, ensureHome } from "../paths.ts";

export function runMigrate(): void {
  ensureHome();
  const db = openDb(dbPath());
  try {
    const applied = migrate(db);
    if (applied.length === 0) {
      console.log(`Nothing to apply. Schema version ${schemaVersion(db)} at ${dbPath()}`);
      return;
    }
    for (const m of applied) console.log(`Applied ${m.name}`);
    console.log(`Schema version ${schemaVersion(db)} at ${dbPath()}`);
  } finally {
    db.close();
  }
}
