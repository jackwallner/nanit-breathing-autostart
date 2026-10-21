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
# Signed builds: Gatekeeper must accept the app as notarised Developer ID software, with the
# ticket stapled so it opens offline too, and the bundled ffmpeg must carry the same signature.
if [ "${NOTARIZED:-}" = "true" ]; then
  spctl --assess --type execute -vv "$app" 2>&1 | tee /dev/stderr | grep -q "source=Notarized Developer ID"
  # stapler asks Apple's servers, which sometimes drop the connection.
  for try in 1 2 3; do xcrun stapler validate "$app" && break; [ "$try" = 3 ] && exit 1; sleep 10; done
  codesign -dv "$app/Contents/Resources/ffmpeg/ffmpeg" 2>&1 | grep -q "TeamIdentifier=YXG4MP6W39"
fi
file "$app/Contents/Resources/ffmpeg/ffmpeg"
BA_APP="$app/Contents/MacOS/Breathing Autostart" BA_SHOTS=shots npm run test:app
