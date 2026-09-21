#!/bin/bash
# Remove the Marshall LaunchAgent: boot it out of launchd and delete the plist. State under
# ~/.marshall (DB, logs, hand-offs) is left alone.
#
# Usage: scripts/uninstall-launchd.sh
# Last edited: 2026-09-21 00:40 CDT
set -euo pipefail

LABEL="com.jacques.marshall"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TARGET="gui/$(id -u)/$LABEL"

if launchctl print "$TARGET" >/dev/null 2>&1; then
  launchctl bootout "$TARGET"
  echo "stopped $LABEL"
fi
if [ -f "$PLIST" ]; then
  rm "$PLIST"
  echo "removed $PLIST"
else
  echo "$PLIST was not installed"
fi
