#!/usr/bin/env bash
# Remove the Linux launcher entry installed by install-launcher.sh.
set -euo pipefail
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
rm -f "$DESKTOP_DIR/buddy-desktop.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true; fi
echo "removed: $DESKTOP_DIR/buddy-desktop.desktop"
