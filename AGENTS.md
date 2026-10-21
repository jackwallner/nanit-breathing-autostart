# Breathing Autostart

Electron app (Mac and Windows) that starts and stops Nanit Breathing Motion monitoring. Public repo; the landing page in `docs/` is mirrored to https://jackwallner.com/breathing-autostart/ by `.github/workflows/sync-landing-page.yml`.

- `src/engine/` is plain Node (no Electron imports). The start/stop rules in `monitor.js` came from the author's own setup (`~/hazy/by-hour/integration/bmm-auto.mjs`) and were tuned against a real camera; keep the 8-minute stop under the camera's own ~10-minute end.
- Never sign in to a real Nanit account from tests or agents. Everything runs against `test/fake-nanit.js`.
- `vendor/ffmpeg/<target>/` is built by `scripts/build-ffmpeg.sh` and is not committed. Keep the build LGPL (no `--enable-gpl`, no `--enable-nonfree`).
- Tests: `npm test` (needs the local ffmpeg), `npm run test:app` (Electron window). CI installs the real installers on macOS arm64, macOS Intel and Windows and drives them.
- Release: bump `version` in package.json, add a CHANGELOG section, tag `vX.Y.Z` and push the tag. Mac builds are Developer ID signed and notarised when the `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` secrets are set; otherwise ad-hoc signed.
- Download links use fixed asset names (`Breathing-Autostart-mac-arm64.dmg`, `-mac-x64.dmg`, `Breathing-Autostart-Setup.exe`) under `releases/latest/download/`; don't rename them.
- `project-docs/` holds internal notes (index in `project-docs/README.md`); `docs/` is the published site only.
