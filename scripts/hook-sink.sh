#!/bin/sh
# Last edited: 2026-09-20 12:30 CDT
# Claude Code hook sink. Appends one JSON line {received_at, event[, stop_blocked]} to $1; stdin is
# the hook payload. Newlines in the payload are only whitespace between JSON tokens, so dropping
# them keeps one event per line. One writer per file and lines are small, so the append is atomic
# on POSIX.
#
# With a second argument (a status file), the Stop guard runs too: when the agent is stopping with
# no outcome in that file, the line carries "stop_blocked":true and the guard's block decision goes
# to stdout, where Claude Code reads it and sends the agent back to work.
set -eu
out="$1"
status="${2:-}"
payload="$(cat)"
verdict=""
if [ -n "$status" ]; then
  verdict="$(printf '%s' "$payload" | bun "$(dirname "$0")/stop-guard.ts" "$status" 2>/dev/null || true)"
fi
mkdir -p "$(dirname "$out")"
{
  printf '{"received_at":"%s","event":' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s' "$payload" | tr -d '\n\r'
  if [ -n "$verdict" ]; then printf ',"stop_blocked":true'; fi
  printf '}\n'
} >> "$out"
if [ -n "$verdict" ]; then printf '%s\n' "$verdict"; fi
