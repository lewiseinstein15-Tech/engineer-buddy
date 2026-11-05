#!/usr/bin/env bash
# Install the Linux launcher entry: Buddy Desktop appears in your app
# launcher (GNOME Activities / KDE menu / dock launchers) with its own icon,
# and launches via desktop/launch.sh — server booted if needed, UI opened in
# its own chromeless app window. Uninstall: desktop/uninstall-launcher.sh
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
ICON="$REPO/desktop/app-icons/icon-512.png"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$DESKTOP_DIR"
chmod +x ./launch.sh

cat > "$DESKTOP_DIR/buddy-desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Buddy Desktop
Comment=engineer-buddy — the keyless AI engineering agent
Exec=$REPO/desktop/launch.sh
Icon=$ICON
Terminal=false
Categories=Development;Utility;
Keywords=buddy;ai;agent;coding;engineer;
StartupWMClass=buddy-desktop
StartupNotify=true
EOF

if command -v desktop-file-validate >/dev/null 2>&1; then desktop-file-validate "$DESKTOP_DIR/buddy-desktop.desktop"; fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true; fi
echo "installed: $DESKTOP_DIR/buddy-desktop.desktop  (Buddy Desktop is in your app launcher)"
