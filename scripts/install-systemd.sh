#!/bin/bash
# Install (or refresh) Marshall as a systemd user service on Linux: render the unit template with
# this machine's bun path, repo path, and config, write it to ~/.config/systemd/user, and start it.
# Safe to rerun: the unit is rewritten, reloaded, and restarted. Running agents survive a restart.
#
# Usage: [MARSHALL_CONFIG=/path/to/config.json] scripts/install-systemd.sh [--dry-run]
#        --dry-run prints the rendered unit and changes nothing.
#        Run it from the main checkout: the unit points at this script's repo, so a run from a
#        worktree would point the real daemon at a feature branch. It refuses to.
# Secrets: put CLAUDE_CODE_OAUTH_TOKEN in ~/.marshall-secrets.env (chmod 600) and the Linear key in
#        <repo>/.env. This script never reads either file.
# Last edited: 2026-10-08 13:56 CDT
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *)
    echo "usage: install-systemd.sh [--dry-run]" >&2
    exit 2
    ;;
esac

case "$REPO" in
  */.worktrees/*)
    echo "install-systemd.sh: $REPO is a worktree; run this from the main checkout" >&2
    exit 1
    ;;
esac

if [ "$(uname -s)" != "Linux" ]; then
  echo "install-systemd.sh: systemd is Linux-only (on macOS use install-launchd.sh)" >&2
  exit 1
fi

BUN="$(command -v bun || true)"
CLAUDE="${MARSHALL_CLAUDE_BIN:-$(command -v claude || true)}"
for pair in "bun:$BUN" "claude:$CLAUDE"; do
  if [ -z "${pair#*:}" ]; then
    echo "install-systemd.sh: ${pair%%:*} not found on PATH (set MARSHALL_CLAUDE_BIN for claude)" >&2
    exit 1
  fi
done
if [ ! -f "$REPO/.env" ]; then
  echo "install-systemd.sh: $REPO/.env is missing; the daemon needs MARSHALL_LINEAR_API_KEY" >&2
  exit 1
fi

CONFIG="${MARSHALL_CONFIG:-$REPO/marshall.config.json}"
if [ ! -f "$CONFIG" ]; then
  echo "install-systemd.sh: config file $CONFIG not found" >&2
  exit 1
fi

# The daemon's PATH: the bun and claude directories, the system directories, and /usr/games
# (Ubuntu puts Stockfish there). Agents need git, gh, and the target repo's tools on it too.
DAEMON_PATH="$(dirname "$BUN"):$(dirname "$CLAUDE"):/usr/local/bin:/usr/bin:/bin:/usr/games"

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/marshall.service"
# Render. sed with | as the delimiter: none of the values may contain one (or an &).
render() {
  sed -e "s|{{BUN}}|$BUN|g" -e "s|{{REPO}}|$REPO|g" -e "s|{{CLAUDE}}|$CLAUDE|g" \
    -e "s|{{CONFIG}}|$CONFIG|g" -e "s|{{PATH}}|$DAEMON_PATH|g" \
    "$REPO/scripts/systemd/marshall.service.template"
}

if [ "$DRY_RUN" = 1 ]; then
  render
  exit 0
fi

mkdir -p "$UNIT_DIR" "$HOME/.marshall/logs"
render > "$UNIT"
systemctl --user daemon-reload
systemctl --user enable marshall
systemctl --user restart marshall
echo "installed $UNIT"

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  echo "warning: linger is off, so the service stops when you log out and does not start at boot." >&2
  echo "         Run: sudo loginctl enable-linger $USER" >&2
fi

echo "bun:    $BUN"
echo "claude: $CLAUDE"
echo "repo:   $REPO"
echo "config: $CONFIG"
echo "logs: journalctl --user -u marshall -f, and $HOME/.marshall/logs/marshall.log"
echo
echo "Check it with: bin/marshall status    Stop it with: systemctl --user stop marshall"
