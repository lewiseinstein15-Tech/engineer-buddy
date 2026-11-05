#!/usr/bin/env bash
# Buddy Desktop launcher — boots the local server if it is not running, then
# opens the UI in its own chromeless app window (Chromium-family --app mode,
# which is what gives the window its own taskbar/launcher identity), falling
# back to a plain tab when no such browser is installed. Used by the OS
# launcher entries the install-* scripts create; also fine to run by hand.
set -euo pipefail
cd "$(dirname "$0")"
URL="http://127.0.0.1:7822"

if ! curl -s --max-time 1 "$URL/api/health" >/dev/null 2>&1; then
  nohup ./start.sh > "${TMPDIR:-/tmp}/buddy-desktop-server.log" 2>&1 &
  for _ in $(seq 1 40); do
    curl -s --max-time 1 "$URL/api/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

case "$(uname -s)" in
  Darwin)
    for b in "/Applications/Google Chrome.app" "/Applications/Microsoft Edge.app" "/Applications/Brave Browser.app" "/Applications/Chromium.app"; do
      if [[ -d "$b" ]]; then exec open -na "$b" --args --app="$URL"; fi
    done
    exec open "$URL"
    ;;
  *)
    # --class groups the window under X11; --wayland-app-id does the same on
    # native-Wayland compositors (Hyprland/Sway — e.g. Omarchy), where --class
    # alone would leave the window id'd as plain "chromium".
    for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
      if command -v "$b" >/dev/null 2>&1; then exec "$b" --app="$URL" --class=buddy-desktop --wayland-app-id=buddy-desktop; fi
    done
    exec xdg-open "$URL"
    ;;
esac
