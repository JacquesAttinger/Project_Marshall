-- Last edited: 2026-09-19 21:28 CDT
-- Initial schema: claims (one per issue), starts (for the caps), events (audit log).
-- Timestamps are ISO-8601 text. slot allows 0-2 so maxAgents can reach 3 without a migration.

CREATE TABLE claims (
  issue_id      TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  slot          INTEGER NOT NULL CHECK (slot IN (0, 1, 2)),
  state         TEXT NOT NULL,
  branch        TEXT,
  worktree_path TEXT,
  bounces       INTEGER NOT NULL DEFAULT 0,
  resumes       INTEGER NOT NULL DEFAULT 0,
  claimed_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX claims_live_slot
  ON claims (slot)
  WHERE state NOT IN ('released', 'blocked');

CREATE TABLE starts (
  id         INTEGER PRIMARY KEY,
  issue_id   TEXT NOT NULL,
  started_at TEXT NOT NULL
);
CREATE INDEX starts_started_at ON starts (started_at);

CREATE TABLE events (
  id       INTEGER PRIMARY KEY,
  ts       TEXT NOT NULL,
  issue_id TEXT,
  agent_id TEXT,
  type     TEXT NOT NULL,
  payload  TEXT
);
CREATE INDEX events_issue ON events (issue_id, ts);
