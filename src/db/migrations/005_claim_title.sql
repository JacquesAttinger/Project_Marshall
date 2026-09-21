-- Last edited: 2026-09-20 23:40 CDT
-- Step 09: the issue title on the claim row, so a push and `marshall status` can name the issue
-- without a Linear round trip. Rows older than this migration keep NULL and fall back to the
-- identifier.

ALTER TABLE claims ADD COLUMN title TEXT;
