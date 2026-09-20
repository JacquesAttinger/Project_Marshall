#!/bin/sh
# Last edited: 2026-09-19 22:10 CDT
# Claude Code hook sink. Appends one JSON line {received_at, event} to $1; stdin is the hook payload.
# Newlines in the payload are only whitespace between JSON tokens, so dropping them keeps one
# event per line. One writer per file and lines are small, so the append is atomic on POSIX.
set -eu
out="$1"
mkdir -p "$(dirname "$out")"
{
  printf '{"received_at":"%s","event":' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tr -d '\n\r'
  printf '}\n'
} >> "$out"
