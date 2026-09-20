-- Last edited: 2026-09-20 15:10 CDT
-- flags: key-value switches the scheduler reads every tick. `pause_until` holds an ISO timestamp;
-- while now < pause_until the scheduler polls but starts nothing (step 08 sets it on a rate limit).

CREATE TABLE flags (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
