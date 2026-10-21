# Outreach research, October 2026

Where parents already complain about starting Nanit Breathing Motion monitoring by hand, and where a post about Breathing Autostart would help rather than read as spam. Researched 2026-10-21. Nothing has been posted.

## What parents complain about

Nanit's help center still documents a manual start: tap the lungs icon, drag the circle onto the band, tap Start ([help article](https://support.nanit.com/en_us/how-do-i-start-monitoring-my-baby's-breathing-motion-H1h3ZhRYgg), updated 2025-08-28). Nanit's own "auto-detect" change in 2022 only removed the circle step; a parent still has to open the app and tap the lungs icon every sleep.

Threads on Nanit's own forum (comments need a sign-in to read; counts from the forum API):

| Thread | Started | Replies | Views | Last reply | Fit |
|---|---|---|---|---|---|
| [Auto start breathing monitor](https://community.nanit.com/discussion/2015/auto-start-breathing-monitor) | 2023-02 | 30 | 1,678 | 2025-11-03 | Exact problem: waited 15 minutes, always had to start it in the app |
| [Breathing wear stopped in the middle of the night with no notifications](https://community.nanit.com/discussion/476/breathing-wear-stopped-in-the-middle-of-the-night-with-no-notifications-or-warning) | 2021-11 | 83 | 3,178 | 2025-03-19 | Sessions ending silently; the app restarts them |
| [Breathing Motion Monitoring Stopping Without Audible Notification](https://community.nanit.com/discussion/4263/breathing-motion-monitoring-stopping-without-audible-notification) | 2024-07 | 20 | 1,056 | 2026-10-13 | Same, still active this month |
| [New Feature! Auto-Detect Breathing Wear](https://community.nanit.com/discussion/958/%EF%BB%BFnew-feature-auto-detect-breathing-wear) | 2022-04 | 17 | 3,617 | 2023-04-10 | Replies say the lungs tap is still needed |
| [Silence "monitoring stopped" chime on the Nanit Pro](https://community.nanit.com/discussion/6155/silence-monitoring-stopped-chime-on-the-nanit-pro) | 2025-07 | 0 | 37 | n/a | The app's "Silence the camera's chime" setting answers it |
| [Tap to Restart Monitoring Issue](https://community.nanit.com/discussion/6011/tap-to-restart-monitoring-issue) | 2025-03 | 1 | 25 | 2025-03-12 | Stuck sessions overnight |

No existing tool does this. Open source Nanit projects ([gregory-m/nanit](https://github.com/gregory-m/nanit), [nanit-web](https://github.com/maddijoyce/nanit-web), [ha-nanit](https://github.com/y4my4my4m/ha-nanit), [mverderese/nanit](https://github.com/mverderese/nanit)) stream video or read sensors and sleep data; none start or stop breathing monitoring.

## Where to post, best first

1. **Nanit forum, thread 2015** (then 4263 and 6155). The people asking are exactly the audience, and the threads rank in search for "Nanit auto start". Needs a Nanit forum account; Nanit moderates its own forum and may remove a link to an unofficial tool, so reply as a parent with the problem it solved, not an ad.
2. **r/Nanit** (about 6k members, growing 18% a year; run by owners, not Nanit). One post with the screenshot. Read the sidebar rules first. Reddit blocks agent tools, so rules weren't checked.
3. **Home Assistant community, "Nanit Baby Monitor Integration"** (22+ pages, people share Nanit projects there). Technical crowd; lead with open source and the protocol work. The forum blocked automated reading, so check recent posts first.
4. **Show HN** on Hacker News. Free, allows things people can try, and the open source, notarized, tested-against-a-fake-Nanit angle suits it. One shot; post on a weekday morning US time.
5. **Parent subreddits** (r/daddit, r/NewParents, r/beyondthebump). Large but most ban self-promotion. Only answer existing Nanit questions where it genuinely fits, never a standalone promo post.
6. **Birth-month clubs** on What to Expect and BabyCenter, and local parent Facebook groups. Same rule: answer someone's Nanit question, don't post cold.

Skip paid placement and Product Hunt for now (no audience overlap with tired Nanit parents).

## Ground rules for every post

- Not a medical device; never claim it makes a baby safer. Say it saves tapping Start every sleep and stops sessions cleanly.
- Say plainly that it's unofficial, uses the parent's own Nanit sign-in, keeps the sign-in on their computer only, and is open source.
- The computer has to stay on and awake; say so up front.
- Posting is Jack's call; nothing goes out from an agent.

## Drafts

### Nanit forum reply (thread 2015)

> Same problem here. Even with auto-detect, someone still has to open the app and tap the lungs icon every nap and every bedtime, and we kept forgetting at 3am.
>
> I ended up writing a small free app for Mac and Windows that does it for you: when the camera sees the baby put down it starts monitoring (usually within a minute), and when the baby is lifted out it stops the session before the "Monitoring stopped" pop-ups hit every phone. It's unofficial (not from Nanit), open source, and your sign-in stays on your computer. The computer has to stay on.
>
> https://jackwallner.com/breathing-autostart/

### r/Nanit post

Title: I got tired of tapping the lungs icon every sleep, so I made a free app that starts Breathing Motion monitoring by itself

> Our daughter's naps kept going unmonitored because one of us forgot to start breathing monitoring, and picking her up meant the "monitoring stopped" chime. So I wrote Breathing Autostart, a free Mac and Windows app.
>
> - Starts monitoring when the baby is put down in the Breathing Band or Swaddle, usually within a minute
> - Stops it when the baby is lifted out (or the band is out of view for 8 minutes), so no "Monitoring stopped" pop-ups on every phone
> - Brief lifts and a blanket over the band don't end anything
> - Optional: silences the camera's "monitoring stopped" chime
> - If you stop monitoring yourself, it waits until the baby is picked up and put back
>
> It's unofficial and not affiliated with Nanit. You sign in with your own Nanit account; only a sign-in token is kept, encrypted, on your computer. Open source (MIT). The computer needs to stay on and awake.
>
> Download and details: https://jackwallner.com/breathing-autostart/
> Code: https://github.com/jackwallner/nanit-breathing-autostart
>
> Not a medical device. Happy to hear what breaks.

### Show HN

Title: Show HN: Breathing Autostart, starts Nanit baby breathing monitoring on its own

> Nanit's camera can track a baby's breathing motion through a patterned band, but a parent has to open the app and tap Start every nap and bedtime, and the session ends with a chime when the baby is picked up. This Electron app watches the camera's own status socket and a low-rate video read, starts monitoring when the baby is put down, and stops it when the baby is lifted out, before the camera's own end-of-session alerts. Signed and notarized on Mac, tested in CI by installing the real DMG/EXE and driving it against a fake Nanit service. MIT licensed.
>
> https://github.com/jackwallner/nanit-breathing-autostart

### Nanit forum reply (threads 4263 and 476, sessions ending overnight)

> This happens to us too. It won't fix the camera losing the band, but one thing that helped: I wrote a small free Mac and Windows app that watches the camera and starts monitoring for you. If a session ends while the baby is still in the crib, it looks for the band again and starts a new session when it finds it (within 15 minutes, sooner if the baby moves). It also starts monitoring when the baby is put down and stops it when they're lifted out, so nobody has to tap the lungs icon.
>
> It's unofficial (not from Nanit), free, open source, and your sign-in stays on your computer. The computer has to stay on. Not a medical device.
>
> https://jackwallner.com/breathing-autostart/

### Nanit forum reply (thread 6155, the "monitoring stopped" chime)

> Not a Nanit setting, but I had the same problem with dream feeds. I wrote a free Mac and Windows app that starts and stops breathing monitoring for you, and it has an option to silence the camera's chime. It also stops the session when the baby is lifted out, so the "Monitoring stopped" pop-ups don't go off on every phone.
>
> It's unofficial, open source, and your sign-in stays on your computer. The computer has to stay on.
>
> https://jackwallner.com/breathing-autostart/

### Home Assistant forum reply ("Nanit Baby Monitor Integration" thread)

> Sharing in case it's useful to anyone here with Breathing Wear: I built an open-source app that starts and stops Nanit Breathing Motion monitoring automatically.
>
> It talks to the camera over the same protobuf websocket as the projects in this thread, reads the camera's own breathing status, and pulls a low-rate frame now and then through ffmpeg to notice when the baby is put down. When it sees that, it asks the camera's own Breathing Wear finder to look and starts a session if the band is found. It stops the session when the camera reports the baby out of bed, or the band has been out of view for 8 minutes (the camera ends it with phone alerts at about 10). Sign-in is Nanit's normal email, password and code flow; only the refresh token is kept, encrypted.
>
> It's an Electron app for Mac and Windows rather than a HA integration, so it's for people who just want it working. The engine in `src/engine/` is plain Node with no Electron imports, if anyone wants to lift the start/stop logic into an add-on.
>
> https://github.com/jackwallner/nanit-breathing-autostart

### Reply template for parent subreddits (r/daddit, r/NewParents, r/beyondthebump)

Only as a reply to someone asking about the Nanit breathing band, forgetting to start it, or the "monitoring stopped" alerts. Check each sub's rules first; skip any that ban links to your own project.

> We had the same thing with the Nanit band, especially forgetting to start it for naps. I ended up making a free app for Mac or Windows that starts the breathing monitoring when the baby's put down and stops it when you pick them up, so you never tap the lungs icon. Unofficial, open source, and the computer has to stay on. https://jackwallner.com/breathing-autostart/ (not a medical device, just saves the tapping)

### Reply template for What to Expect, BabyCenter and Facebook parent groups

Same rule: reply to an existing Nanit question only. These sites often hold or strip links from new accounts, so the text works without the link too.

> If you have a computer that stays on at home, there's a free app called Breathing Autostart that starts Nanit's breathing monitoring by itself when the baby's put down and stops it when they're picked up. I made it after forgetting to start it one too many times. Search "Breathing Autostart Nanit" or go to jackwallner.com/breathing-autostart. It's not from Nanit and it's not a medical device, it just saves the tapping.
