// Last edited: 2026-09-21 01:00 CDT
// `marshall pause` / `marshall resume`: the manual pause flag. Pause stops new starts only; the
// agents already running finish their issue (`marshall kill` is the per-issue stop). Independent
// of the rate-limit pause, so a rate-limit resume can never clear a pause a human set.

import { manualPauseAt, pauseUntil, setManualPause } from "../caps.ts";
import { migrate, openDb } from "../db/index.ts";
import { dbPath, ensureHome } from "../paths.ts";

export function runPause(now: () => Date = () => new Date()): number {
  ensureHome();
  const db = openDb(dbPath());
  try {
    migrate(db);
    const already = manualPauseAt(db);
    if (already) {
      console.log(`marshall: already paused since ${already}`);
      return 0;
    }
    setManualPause(db, now());
    console.log(
      "marshall: paused. No new issues start; running agents finish theirs. `marshall resume` to undo.",
    );
    return 0;
  } finally {
    db.close();
  }
}

export function runResume(now: () => Date = () => new Date()): number {
  ensureHome();
  const db = openDb(dbPath());
  try {
    migrate(db);
    const was = manualPauseAt(db);
    setManualPause(db, null);
    const until = pauseUntil(db);
    const rateLimit =
      until && until.getTime() > now().getTime()
        ? ` A rate-limit pause is still in effect until ${until.toISOString()}.`
        : "";
    console.log(
      was
        ? `marshall: resumed (was paused since ${was}).${rateLimit}`
        : `marshall: was not paused.${rateLimit}`,
    );
    return 0;
  } finally {
    db.close();
  }
}
