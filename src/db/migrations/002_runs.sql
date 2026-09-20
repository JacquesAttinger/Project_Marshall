-- Last edited: 2026-09-19 22:00 CDT
-- runs: one row per `claude --bg` launch or resume. Maps Marshall's run_id to the daemon's
-- job_id and the Claude session_id. events_offset is how far the run's hook file has been ingested.

CREATE TABLE runs (
  run_id        TEXT PRIMARY KEY,
  job_id        TEXT,
  session_id    TEXT,
  name          TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  state         TEXT NOT NULL,
  error         TEXT,
  resumed_from  TEXT,
  events_offset INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX runs_job ON runs (job_id);
CREATE INDEX runs_session ON runs (session_id);
