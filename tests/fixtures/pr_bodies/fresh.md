**TLDR:** The health endpoint now reports the API version.
Two lines of summary.

## What changed

- `services/api/api/routes/health.py` — add `version` to the payload.
- `services/api/tests/test_health.py` — assert it.

## Hand-off

<!-- marshall-handoff:start -->
_Filled in by the hand-off step._
<!-- marshall-handoff:end -->

Closes https://linear.app/chessbuddy/issue/CB-12
