**TLDR:** The health endpoint now reports the API version.

## What changed

- `services/api/api/routes/health.py` — add `version` to the payload.

Closes https://linear.app/chessbuddy/issue/CB-12
