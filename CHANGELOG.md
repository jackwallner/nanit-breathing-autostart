# Changelog

## 1.0.1

- The Mac app is now signed and notarised by Apple, so it opens without a security warning and updates itself. If you installed 1.0.0 on a Mac, download 1.0.1 once by hand; updates are automatic from then on.
- A dropped camera connection no longer looks like a new session (which could start a needless 10-minute wait), and a session stopped while the connection was down is noticed.
- Reconnects to the camera right after the computer wakes from sleep.
- A stop the camera refuses is sent again, so a session is never left to run into Nanit's own dialog.
- Moving the band to a new spot no longer counts as a false start.
- One more Breathing Wear check two minutes after the baby is settled, in case a hand hid the band.
- "Send a new code" on the code screen.
- Signing out and back in never reuses the old account's sign-in, and a sign-in Nanit just renewed is kept even if saving it fails.
- An offline camera shows as a problem after 5 minutes instead of "Connecting" for 30.
- Silencing the camera's chime applies at once, and turning the setting off turns the chime back on.
- Quitting stops the video reader, and a second copy of the app no longer connects to the camera.

## 1.0.0

- First release for Mac (Apple silicon and Intel) and Windows.
- Signs in with your Nanit account and the code Nanit sends you; keeps only encrypted sign-in tokens.
- Starts Breathing Motion monitoring when Breathing Wear comes into view and stops it when your baby is out of bed or the band has been out of view for 8 minutes.
- Waits after a stop in the Nanit app, backs off after false starts, and supports more than one camera.
- Menu bar / tray icon, opens at login, keeps the computer awake, notifies you if something's wrong, updates itself.

