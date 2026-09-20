#!/bin/sh
# Last edited: 2026-09-19 22:05 CDT
# Claude Code hook sink. Appends one JSON line {received_at, event} to $1; stdin is the hook payload.
# One writer per file and lines are small, so the append is atomic on POSIX filesystems.
set -eu
out="$1"
mkdir -p "$(dirname "$out")"
{
  printf '{"received_at":"%s","event":' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat
  printf '}\n'
} >> "$out"
