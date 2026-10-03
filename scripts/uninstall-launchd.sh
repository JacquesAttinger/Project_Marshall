#!/bin/bash
# Remove one of Marshall's LaunchAgents (or both): boot it out of launchd and delete the plist.
# State under ~/.marshall (DB, logs, hand-offs) is left alone.
#
# Usage: scripts/uninstall-launchd.sh daemon | dashboard | all
# Last edited: 2026-10-03 18:28 CDT
set -euo pipefail

case "${1:-}" in
  daemon) LABELS=("com.jacques.marshall") ;;
  dashboard) LABELS=("com.jacques.marshall-dashboard") ;;
  all) LABELS=("com.jacques.marshall" "com.jacques.marshall-dashboard") ;;
  *)
    echo "usage: uninstall-launchd.sh daemon | dashboard | all" >&2
    exit 2
    ;;
esac

for LABEL in "${LABELS[@]}"; do
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
done
