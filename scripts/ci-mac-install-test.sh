#!/usr/bin/env bash
# CI: installs the app from a disk image the way a parent would, checks its signature, and
# drives the installed copy against the fake Nanit.
set -euo pipefail
dmg=${1:?usage: ci-mac-install-test.sh <dmg>}
mount=$(mktemp -d)
hdiutil attach "$dmg" -nobrowse -mountpoint "$mount"
rm -rf "/Applications/Breathing Autostart.app"
cp -R "$mount/Breathing Autostart.app" /Applications/
hdiutil detach "$mount"
app="/Applications/Breathing Autostart.app"
codesign --verify --deep --strict "$app"
codesign -dv "$app" 2>&1 | grep -E "Authority|Signature|TeamIdentifier" || true
file "$app/Contents/Resources/ffmpeg/ffmpeg"
BA_APP="$app/Contents/MacOS/Breathing Autostart" BA_SHOTS=shots npm run test:app
