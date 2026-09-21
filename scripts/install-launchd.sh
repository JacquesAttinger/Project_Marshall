#!/bin/bash
# Install (or refresh) the Marshall LaunchAgent: render the plist template with this machine's
# bun path, repo path, and home, drop it in ~/Library/LaunchAgents, and bootstrap it. Safe to
# rerun: an already-loaded agent is booted out first so the new plist takes effect.
#
# Usage: scripts/install-launchd.sh            (from anywhere; the repo is found from this file)
# Last edited: 2026-09-21 13:55 CDT
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

# The claude binary, skipping cmux's shim directory (its shim rewrites `claude stop`). launchd
# does not read ~/.zshrc, so the daemon would otherwise not find ~/.local/bin/claude.
CLAUDE="${MARSHALL_CLAUDE_BIN:-}"
if [ -z "$CLAUDE" ]; then
  IFS=: read -ra PATH_DIRS <<< "$PATH"
  for dir in "${PATH_DIRS[@]}"; do
    case "$dir" in *cmux-cli-shims*) continue ;; esac
    if [ -x "$dir/claude" ]; then CLAUDE="$dir/claude"; break; fi
  done
fi
if [ -z "$CLAUDE" ]; then
  echo "install-launchd.sh: claude not found on PATH (set MARSHALL_CLAUDE_BIN to override)" >&2
  exit 1
fi

# The daemon's PATH: this shell's, minus cmux's shim directories, so the agents it spawns find
# git, gh, docker, uv, pnpm, and whatever else the target repo's checks need.
DAEMON_PATH=""
IFS=: read -ra PATH_DIRS <<< "$PATH"
for dir in "${PATH_DIRS[@]}"; do
  case "$dir" in ""|*cmux-cli-shims*) continue ;; esac
  case ":$DAEMON_PATH:" in *":$dir:"*) continue ;; esac
  DAEMON_PATH="${DAEMON_PATH:+$DAEMON_PATH:}$dir"
done
if [ ! -f "$REPO/.env" ]; then
  echo "install-launchd.sh: $REPO/.env is missing; the daemon needs MARSHALL_LINEAR_API_KEY" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.marshall/logs"

# Render. sed with | as the delimiter: none of the values may contain one (or an &).
sed -e "s|{{BUN}}|$BUN|g" -e "s|{{REPO}}|$REPO|g" -e "s|{{HOME}}|$HOME|g" \
  -e "s|{{CLAUDE}}|$CLAUDE|g" -e "s|{{PATH}}|$DAEMON_PATH|g" "$TEMPLATE" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

# Reload if it is already there, so a changed plist is picked up.
if launchctl print "$TARGET" >/dev/null 2>&1; then
  launchctl bootout "$TARGET"
fi
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed $PLIST"
echo "bun:    $BUN"
echo "claude: $CLAUDE"
echo "repo:   $REPO"
echo "logs: $HOME/.marshall/logs/launchd.{out,err}.log and marshall.log"
echo
echo "Check it with: marshall status    Stop it with: marshall stop"
