#!/bin/bash
# Install (or refresh) the Marshall LaunchAgent: render the plist template with this machine's
# bun path, repo path, and home, drop it in ~/Library/LaunchAgents, and bootstrap it. Safe to
# rerun: an already-loaded agent is booted out first so the new plist takes effect.
#
# Usage: scripts/install-launchd.sh            (from anywhere; the repo is found from this file)
# Last edited: 2026-09-21 00:40 CDT
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

LABEL="com.jacques.marshall"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TEMPLATE="$REPO/scripts/launchd/$LABEL.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TARGET="gui/$(id -u)/$LABEL"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "install-launchd.sh: launchd is macOS-only" >&2
  exit 1
fi

BUN="$(command -v bun || true)"
if [ -z "$BUN" ]; then
  echo "install-launchd.sh: bun not found on PATH" >&2
  exit 1
fi
if [ ! -f "$REPO/.env" ]; then
  echo "install-launchd.sh: $REPO/.env is missing; the daemon needs MARSHALL_LINEAR_API_KEY" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.marshall/logs"

# Render. sed with | as the delimiter: none of the three values may contain one.
sed -e "s|{{BUN}}|$BUN|g" -e "s|{{REPO}}|$REPO|g" -e "s|{{HOME}}|$HOME|g" "$TEMPLATE" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

# Reload if it is already there, so a changed plist is picked up.
if launchctl print "$TARGET" >/dev/null 2>&1; then
  launchctl bootout "$TARGET"
fi
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed $PLIST"
echo "bun:  $BUN"
echo "repo: $REPO"
echo "logs: $HOME/.marshall/logs/launchd.{out,err}.log and marshall.log"
echo
echo "Check it with: marshall status    Stop it with: marshall stop"
