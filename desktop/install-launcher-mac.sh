#!/usr/bin/env bash
# macOS: build ~/Applications/Buddy Desktop.app — a real app bundle (own icon
# in the Dock and Launchpad) that boots the local server if needed and opens
# the UI in its own chromeless app window. Linux-only machines: this refuses
# politely; use install-launcher.sh instead.
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "this installer is for macOS — on Linux run desktop/install-launcher.sh" >&2
  exit 1
fi
REPO="$(cd .. && pwd)"
DEST="$HOME/Applications/Buddy Desktop.app"
mkdir -p "$DEST/Contents/MacOS" "$DEST/Contents/Resources"
cp app-icons/AppIcon.icns "$DEST/Contents/Resources/AppIcon.icns"

cat > "$DEST/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Buddy Desktop</string>
  <key>CFBundleDisplayName</key><string>Buddy Desktop</string>
  <key>CFBundleIdentifier</key><string>tech.engineerbuddy.desktop</string>
  <key>CFBundleVersion</key><string>0.69.1</string>
  <key>CFBundleShortVersionString</key><string>0.69.1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>BuddyDesktop</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
EOF

cat > "$DEST/Contents/MacOS/BuddyDesktop" <<EOF
#!/bin/bash
exec "$REPO/desktop/launch.sh"
EOF
chmod +x "$DEST/Contents/MacOS/BuddyDesktop"
touch "$DEST"   # bump mtime so LaunchServices re-reads the bundle
echo "installed: $DEST  (find Buddy Desktop in Launchpad / Spotlight)"
