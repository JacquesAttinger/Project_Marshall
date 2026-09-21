-- Last edited: 2026-09-20 22:35 CDT
-- Step 08: parked states free the slot (awaiting_human, rebasing) so a PR waiting on a human
-- does not block a new start; the row and worktree stay for rebases and bounces. The master
-- agent also keeps the plan path, the planner model, the PR URL, the fresh-restart count, and
-- the merged PR that queued a rebase on the claim itself.

DROP INDEX claims_live_slot;
CREATE UNIQUE INDEX claims_live_slot
  ON claims (slot)
  WHERE state NOT IN ('released', 'blocked', 'awaiting_human', 'rebasing');

ALTER TABLE claims ADD COLUMN plan_path      TEXT;
ALTER TABLE claims ADD COLUMN model          TEXT;
ALTER TABLE claims ADD COLUMN pr_url         TEXT;
ALTER TABLE claims ADD COLUMN fresh_restarts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN rebase_after   TEXT;
