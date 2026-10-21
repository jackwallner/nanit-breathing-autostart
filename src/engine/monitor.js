// One baby's autostart. Starts Nanit Breathing Motion monitoring when the baby is put down
// wearing Breathing Wear and stops it when they're picked up.
//
// Nanit's own in-bed events arrive 7 to 16 minutes late, so the trigger is the live picture:
// when it changes, a full frame goes to Nanit's Breathing Wear finder (what the app's one-tap
// start does), and a find starts a session at the pattern's centre. Stopping is the other half:
// when the camera reports BABY_NOT_IN_BED, or can't see the wear for 8 minutes, the session is
// stopped from here, so Nanit shows a small "stopped by" note instead of its full-screen
// "Monitoring stopped" or "Stop monitoring?" dialogs.
//
// A searching session is left alone as long as it safely can: a brief lift or a covered band
// ends with no alert at all, and while it searches the band is looked for here too. Found where
// the session started, the camera re-locks by itself; found somewhere else, the session restarts
// there at once. Never wait 10 minutes: the camera ends an out-of-crib session by itself about
// then, and that end brings back the full-screen dialog.
import WebSocket from "ws";

import { HEADERS } from "./endpoints.js";
import * as bmm from "./protocol.js";
import { SignedOutError } from "./auth.js";
import { nanitVideo, streamInput } from "./video.js";

const IN_BED = new Set(["PUT_IN_BED", "PUT_TO_SLEEP", "PUT_TO_BED_AWAKE"]);
const OUT_OF_BED = new Set(["REMOVED", "REMOVED_ASLEEP"]);
export const CHECK_GAP = 60_000; // at most one Breathing Wear check a minute
export const IDLE_CHECK = 15 * 60_000; // and one every 15 minutes even if the picture is still
export const HOURLY_CHECKS = 30;
export const AFTER_END = 60_000; // after a session ends, before checking again (they may be on their way out)
export const QUICK_END = 3 * 60_000; // a session started here that ends this fast was a false start
export const SEARCH_STOP = 8 * 60_000; // can't see the wear this long: stop before the camera's own ~10-minute end
export const SEARCH_CHECK = 3 * 60_000; // searching this long, and every 3 minutes after: look for the band here too
export const MOVED = 60; // camera pixels between the session's point and a find that count as a new spot
// Nanit's app pops its "couldn't find Breathing Wear" dialog after 20 minutes in these.
export const SEARCHING = new Set(["INIT", "LACK_TEXTURE", "NO_PATTERN"]);
export const CHANGED = 6; // mean grey-level change (0-255) of the 32 x 18 thumbnail that counts as movement
export const PROBLEM_COUNT = 3; // a stage failing this many times...
export const PROBLEM_FOR = 5 * 60_000; // ...over this long is shown as a problem
export const CAMERA_SILENCE = 30 * 60_000;
export const SETTLE = 2 * 60_000; // a check that found nothing while the picture was moving gets one more this long after

// Loop timings. Tests run them faster.
export const TIMING = { watch: 30_000, events: 60_000, status: 20_000, silentSocket: 75_000, reconnect: 10_000, reconnectAfterError: 30_000 };

// The newest put-down or take-out in Nanit's (late) feed.
export function presence(events) {
  const latest = events.filter((e) => IN_BED.has(e.key) || OUT_OF_BED.has(e.key)).sort((a, b) => b.time - a.time)[0];
  return latest ? { inBed: IN_BED.has(latest.key), uid: latest.uid ?? String(latest.time), key: latest.key, time: latest.time } : null;
}

export function difference(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// Folds a camera status into the state. Returns a note when a session just started or ended.
export function observe(s, status, now) {
  const wasLive = bmm.LIVE.has(s.status?.state);
  const live = bmm.LIVE.has(status.state);
  // After a reconnect the status is unknown until the camera answers, so the session last heard
  // of (s.liveSession) says whether this is the same session carrying on or a new one.
  const resumed = !wasLive && s.liveSession != null && (status.sessionId ?? s.liveSession) === s.liveSession;
  s.status = status;
  if (live) {
    s.sessionId = status.sessionId ?? s.sessionId;
    if (SEARCHING.has(status.breathing)) s.searchingSince ??= now;
    else if (status.breathing) s.searchingSince = null;
    if (status.breathing === "NORMAL") s.sawBreathing = true;
    if (!wasLive && !resumed) {
      s.startedAt = now;
      s.sawBreathing = status.breathing === "NORMAL";
      s.liveSession = s.sessionId;
      if (s.sessionId !== s.ourStart) s.startPoint = null; // a parent's session: its point is unknown
      return "started";
    }
    s.liveSession = s.sessionId;
    return null;
  }
  s.searchingSince = null;
  if (!wasLive && s.liveSession == null) return null;
  s.liveSession = null; // ended, perhaps while the connection was down
  const ended = s.sessionId;
  s.endedAt = now;
  // Ended within minutes of our start (held over the bed, say), or never picked up breathing:
  // back off so it can't loop.
  // A restart in a new spot is ours too, but not a false start.
  if (ended === s.ourStart && ended !== s.restarting && s.startedAt && (now - s.startedAt < QUICK_END || !s.sawBreathing)) {
    s.quickEnds = (s.quickEnds ?? 0) + 1;
    s.backoffUntil = now + (s.quickEnds === 1 ? 10 : 30) * 60_000;
  } else s.quickEnds = 0;
  if (status.state === "COMPLETED" && ended !== s.ourStop) {
    s.parentStop = true;
    return "stopped by a parent";
  }
  return `ended (${status.state})`;
}

const checkBudget = (s, now) => now - (s.checkedAt ?? 0) >= CHECK_GAP && (s.checks ?? []).filter((at) => now - at < 3_600_000).length < HOURLY_CHECKS;

export function decide(s, now) {
  if (!s.status) return null;
  if (bmm.LIVE.has(s.status.state)) {
    if (!s.sessionId || s.ourStop === s.sessionId) return null;
    if (s.status.breathing === "BABY_NOT_IN_BED") return { do: "stop", sessionId: s.sessionId, reason: "out of bed" };
    if (s.searchingSince && now - s.searchingSince >= SEARCH_STOP) return { do: "stop", sessionId: s.sessionId, reason: "no Breathing Wear in view" };
    if (s.searchingSince && now - s.searchingSince >= SEARCH_CHECK && now - (s.checkedAt ?? 0) >= SEARCH_CHECK && checkBudget(s, now)) return { do: "check", reason: "searching" };
    return null;
  }
  if (s.endedAt && now - s.endedAt < AFTER_END) return null;
  if (!checkBudget(s, now)) return null;
  const last = s.checkedAt ?? 0;
  // Laid down and then still: the band may have been hidden by a hand at the last check.
  const settling = s.lastFound === false && (s.changedAt ?? 0) > last - SETTLE && now - last >= SETTLE;
  const reason = (s.changedAt ?? 0) > last ? "movement" : (s.putDownAt ?? 0) > last ? "put down" : settling ? "settling" : now - last >= IDLE_CHECK ? "idle" : null;
  return reason ? { do: "check", reason } : null;
}

// What a find means while a session is still searching: where it started, the camera re-locks by
// itself; anywhere else (or a parent's session, whose point is unknown), restart there.
export function duringSearch(s, found) {
  if (!found) return null;
  if (s.startPoint && Math.hypot(found.x - s.startPoint.x, found.y - s.startPoint.y) <= MOVED) return "wait";
  return "restart";
}

// What a check found: start, or just note it. With holdAfterParentStop, a parent's stop in the
// Nanit app holds autostart off until the band is out of view (the baby was picked up).
export function afterCheck(s, found, now, { holdAfterParentStop = true } = {}) {
  if (!found) { s.parentStop = false; return null; }
  if (s.backoffUntil && now < s.backoffUntil) return "backing off after a false start";
  if (holdAfterParentStop && s.parentStop) return "held after a stop in the Nanit app";
  return "start";
}

// Problems worth showing: a stage failing over and over, or a camera that's gone quiet.
export function problem(health, now) {
  for (const [stage, fault] of Object.entries(health.failures)) {
    if (fault.count >= PROBLEM_COUNT && now - fault.since >= PROBLEM_FOR) return { stage, error: fault.error, since: fault.since };
  }
  if (health.connectedAt && now - health.lastCameraAt >= CAMERA_SILENCE) return { stage: "camera connection", error: "No word from the camera.", since: health.lastCameraAt };
  return null;
}

// What the window shows for a monitor.
export function phase({ enabled, status, connected, problem: fault }) {
  if (fault) return "problem";
  if (!connected || !status) return "connecting";
  if (bmm.LIVE.has(status.state)) return SEARCHING.has(status.breathing) || status.breathing === "BABY_NOT_IN_BED" ? "searching" : "monitoring";
  return enabled ? "watching" : "off";
}

// A short, parent-facing line for each thing that happens.
const STOP_TEXT = { "out of bed": "Stopped monitoring: baby out of bed", "no Breathing Wear in view": "Stopped monitoring: Breathing Wear out of view for 8 minutes",
  "band in a new spot": "Breathing Wear moved, restarting monitoring" };

export function createMonitor({ baby, userId, endpoints, token, ffmpegBin, videoInput, settings, timing = TIMING,
  log = () => {}, onChange = () => {}, onActivity = () => {}, onSignedOut = () => {} }) {
  const babyUid = baby.uid, cameraUid = baby.camera.uid;
  const s = { status: null, checks: [], checkedAt: 0, changedAt: 0 };
  const health = { failures: {}, lastCameraAt: Date.now(), connectedAt: 0 };
  const timers = [];
  let reconnectTimer = null;
  let socket = null, lastMessage = 0, nextId = 1000, disposed = false, connected = false;
  const waiting = new Map();
  const tag = { baby: baby.name };
  const note = (what, extra = {}) => log(what, { ...tag, ...extra });
  const enabled = () => settings().enabled(babyUid);

  const fail = (stage, error) => {
    if (disposed) return;
    if (error instanceof SignedOutError) return onSignedOut(error);
    const previous = health.failures[stage];
    health.failures[stage] = { since: previous?.since ?? Date.now(), count: (previous?.count ?? 0) + 1, error: String(error?.message ?? error).slice(0, 300) };
    changed();
  };
  const ok = (stage) => { if (health.failures[stage]) { delete health.failures[stage]; changed(); } };
  const activity = (text) => { if (!disposed) onActivity({ at: Date.now(), baby: baby.name, babyUid, text }); };

  const snapshot = () => {
    const fault = problem(health, Date.now());
    return {
      uid: babyUid, name: baby.name, enabled: enabled(), connected,
      phase: phase({ enabled: enabled(), status: s.status, connected, problem: fault }),
      state: s.status?.state ?? null, breathing: s.status?.breathing ?? null, bpm: s.status?.bpm ?? null,
      startedAt: bmm.LIVE.has(s.status?.state) ? s.startedAt ?? null : null,
      problem: fault, backoffUntil: s.backoffUntil && s.backoffUntil > Date.now() ? s.backoffUntil : null,
      held: Boolean(s.parentStop && settings().holdAfterParentStop),
    };
  };
  let last = "";
  const changed = () => {
    if (disposed) return;
    const now = snapshot();
    const key = JSON.stringify(now);
    if (key !== last) { last = key; onChange(now); }
  };

  const api = async (url) => {
    let failed;
    for (const retry of [false, true]) {
      const auth = await token(retry ? { failed } : {});
      const response = await fetch(`${endpoints.api}${url}`, { headers: { ...HEADERS, Authorization: auth }, signal: AbortSignal.timeout(20_000) });
      if (response.status === 401 && !retry) { failed = auth; continue; }
      if (!response.ok) throw new Error(`Nanit ${url.split("?")[0]} returned ${response.status}.`);
      return response.json();
    }
  };

  const send = (build, type) => new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) return reject(new Error("The camera connection is closed."));
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`The camera didn't answer (type ${type}).`)); }, 20_000);
    waiting.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
    socket.send(build(id));
  });

  const video = nanitVideo({
    ffmpegBin, babyUid, token, log: note,
    input: videoInput ?? streamInput(endpoints.media),
    requestStream: async () => {
      const url = `${endpoints.media}/${babyUid}.${await token()}`;
      const reply = await send((id) => bmm.streaming(id, url), bmm.TYPE.PUT_STREAMING);
      if (reply.statusCode !== 200) throw new Error(`The camera refused to stream (${reply.statusCode}${reply.statusMessage ? `: ${reply.statusMessage}` : ""}).`);
    },
  });
  // Nothing needs the picture while a session runs normally, or while autostart is off.
  const needVideo = () => enabled() && !(bmm.LIVE.has(s.status?.state) && !s.searchingSince);
  const tidyVideo = () => { if (!needVideo()) video.pause(); };

  const onStatus = (status) => {
    ok("camera");
    const before = s.status?.state;
    const wasOurs = s.sessionId === s.ourStart;
    const result = observe(s, status, Date.now());
    health.lastCameraAt = Date.now();
    if (status.state !== before) note("camera", { state: status.state, breathing: status.breathing, session: s.sessionId });
    if (result) note(`session ${result}`, { session: s.sessionId, backoffUntil: s.backoffUntil ? new Date(s.backoffUntil).toISOString() : undefined });
    if (result === "started" && s.sessionId !== s.ourStart) activity("Monitoring started in the Nanit app");
    if (result === "stopped by a parent") activity("Monitoring stopped in the Nanit app");
    else if (result?.startsWith("ended") && !(wasOurs && s.ourStop === s.sessionId)) activity("Monitoring ended by the camera");
    if (result?.startsWith("ended") && s.backoffUntil > Date.now() && wasOurs) activity(`Monitoring ended quickly. Waiting ${s.quickEnds === 1 ? 10 : 30} minutes before trying again`);
    tidyVideo();
    changed();
    act();
  };

  const connect = async () => {
    if (disposed) return;
    let auth;
    try {
      auth = await token();
      if (disposed) return;
      socket = new WebSocket(`${endpoints.socket}/${cameraUid}/user_connect`, { headers: { Authorization: `Bearer ${auth}` } });
    } catch (error) {
      fail("camera connection", error);
      note("socket failed", { error: String(error?.message ?? error).slice(0, 300) });
      reconnect(timing.reconnectAfterError);
      return;
    }
    const ws = socket;
    ws.binaryType = "arraybuffer";
    lastMessage = Date.now();
    let opened = false, refused = false;
    ws.onopen = () => {
      opened = true;
      connected = true;
      health.connectedAt = Date.now();
      ok("camera connection");
      note("socket open");
      askStatus();
      chimeSent = null;
      applyChime();
      changed();
    };
    ws.onmessage = (event) => {
      lastMessage = Date.now();
      let message;
      try { message = bmm.parse(new Uint8Array(event.data)); } catch { return; }
      if (message.kind === "request") {
        ws.send(bmm.ack(message.id, message.type));
        if (message.status) onStatus(message.status);
      } else if (message.kind === "response") {
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
        if (message.status) onStatus(message.status);
      }
    };
    ws.onclose = (event) => {
      if (socket === ws) socket = null;
      connected = false;
      s.status = null; // unknown until the camera is heard from again
      if (disposed) return;
      note("socket closed", { code: event.code });
      // Refused before opening: the access token may have been revoked early, so get a new one.
      if (!opened && refused) token({ failed: auth }).catch((error) => { if (error instanceof SignedOutError && !disposed) onSignedOut(error); });
      fail("camera connection", `Camera connection closed (${event.code}).`);
      reconnect(timing.reconnect);
    };
    ws.onerror = (event) => { if (/server response: 40[13]/.test(String(event?.message ?? event?.error?.message ?? ""))) refused = true; };
  };

  // The camera answers status requests even when idle; an offline camera doesn't.
  const askStatus = () => send(bmm.getStatus, bmm.TYPE.GET_STING_STATUS).catch((error) => fail("camera", error));

  // The camera's start/stop chime is only touched when the parent silenced it, and turned back on
  // when they change their mind. Having muted it is remembered (settings), across restarts too.
  let chimeSent = null, chimeBusy = false;
  const applyChime = () => {
    const muted = chimeSent === false || (chimeSent === null && Boolean(settings().chimeMuted?.(babyUid)));
    const want = settings().silenceChime ? false : muted ? true : null;
    if (want === null || want === chimeSent || chimeBusy || socket?.readyState !== WebSocket.OPEN) return;
    chimeBusy = true;
    send((id) => bmm.chime(id, want), bmm.TYPE.PUT_SETTINGS)
      .then((reply) => {
        note("chime set", { on: want, statusCode: reply.statusCode });
        chimeBusy = false;
        if (reply.statusCode !== 200) return;
        chimeSent = want;
        settings().setChimeMuted?.(babyUid, !want);
        applyChime(); // the setting may have changed meanwhile
      })
      .catch((error) => { chimeBusy = false; note("chime failed", { error: String(error.message ?? error) }); });
  };

  const reconnect = (delay) => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  };

  const check = async (reason) => {
    s.checkedAt = Date.now();
    s.checks = [...s.checks.filter((at) => s.checkedAt - at < 3_600_000), s.checkedAt];
    const frame = await video.grab();
    if (!frame) throw new Error("Nanit's stream has no live video.");
    let pattern = null, variant = null;
    for (variant of ["soft", "raw"]) {
      pattern = await bmm.findPattern({ api: endpoints.api, token: await token(), babyUid, png: frame[variant],
        infrared: frame.infrared, width: frame.width, height: frame.height });
      if (pattern) break;
    }
    const live = bmm.LIVE.has(s.status?.state);
    s.lastFound = Boolean(pattern);
    const next = live ? duringSearch(s, pattern) : afterCheck(s, pattern, Date.now(), settings());
    note("checked", { reason, found: Boolean(pattern), variant: pattern ? variant : undefined, score: pattern?.score, infrared: frame.infrared, next: next ?? undefined });
    changed();
    if (next === "restart") {
      s.restarting = s.sessionId;
      await stopSession(s.sessionId, "band in a new spot");
      await sessionOver();
    } else if (next !== "start" || live) return; // a parent may have started it meanwhile
    await startSession(pattern);
  };
  const startSession = async (pattern) => {
    const sessionId = bmm.sessionId();
    s.ourStart = sessionId;
    s.startPoint = { x: pattern.x, y: pattern.y };
    const reply = await send((id) => bmm.start(id, { ...pattern, sessionId }), bmm.TYPE.PUT_STING_START);
    note("start sent", { sessionId, x: pattern.x, y: pattern.y, statusCode: reply.statusCode });
    if (reply.statusCode !== 200) throw new Error(`Nanit didn't accept the start (${reply.statusCode}).`);
    activity("Breathing Wear in view. Started monitoring");
  };
  // The camera reports the end a second or two after a stop; a start before that would be refused.
  const sessionOver = async () => {
    for (let waited = 0; waited < 15_000; waited += 500) {
      if (!bmm.LIVE.has(s.status?.state)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("The camera didn't end the session after the stop.");
  };
  const stopSession = async (sessionId, reason) => {
    s.ourStop = sessionId;
    let reply;
    try {
      reply = await send((id) => bmm.stop(id, userId), bmm.TYPE.PUT_STING_STOP);
      note("stop sent", { sessionId, reason, statusCode: reply.statusCode });
      if (reply.statusCode !== 200) throw new Error(`Nanit didn't accept the stop (${reply.statusCode}).`);
    } catch (error) {
      if (s.ourStop === sessionId) s.ourStop = null; // try again on the next status
      throw error;
    }
    activity(STOP_TEXT[reason] ?? "Stopped monitoring");
  };

  let busy = false;
  async function act() {
    if (busy || disposed || !enabled()) return;
    const action = decide(s, Date.now());
    if (!action) return;
    busy = true;
    try {
      if (action.do === "stop") await stopSession(action.sessionId, action.reason);
      else await check(action.reason);
      ok(action.do);
      if (action.do === "check") ok("watch");
    } catch (error) {
      fail(action.do, error);
      note(`${action.do} failed`, { error: String(error.message ?? error).slice(0, 300) });
    } finally { busy = false; changed(); }
  }

  let previous = null;
  const watch = async () => {
    if (busy || disposed || !s.status || !needVideo() || bmm.LIVE.has(s.status.state)) { previous = null; return; }
    try {
      const grey = await video.thumbnail();
      if (!grey) throw new Error("Nanit's stream has no live video.");
      ok("watch");
      if (previous && difference(previous, grey) >= CHANGED) s.changedAt = Date.now();
      previous = grey;
      act();
    } catch (error) {
      fail("watch", error);
    }
  };

  let lastPresence = null;
  const pollEvents = async () => {
    if (disposed) return;
    try {
      const { events = [] } = await api(`/babies/${babyUid}/events?limit=40`);
      const latest = presence(events);
      if (latest && latest.uid !== lastPresence?.uid) {
        if (lastPresence) {
          note("nanit event", { key: latest.key, eventAt: new Date(latest.time * 1000).toISOString() });
          if (latest.inBed) s.putDownAt = Date.now();
        }
        lastPresence = latest;
      }
      ok("events");
      act();
    } catch (error) {
      if (disposed) return;
      if (error instanceof SignedOutError) return onSignedOut(error);
      note("events failed", { error: String(error.message ?? error).slice(0, 300) });
    }
  };

  const checkHealth = () => {
    if (socket && Date.now() - lastMessage > timing.silentSocket) { note("socket silent, reconnecting"); socket.terminate(); }
    else if (socket?.readyState === WebSocket.OPEN) askStatus();
    tidyVideo();
    changed();
  };

  return {
    uid: babyUid,
    async start() {
      await connect();
      pollEvents();
      timers.push(setInterval(pollEvents, timing.events), setInterval(watch, timing.watch), setInterval(checkHealth, timing.status));
      changed();
    },
    // Autostart was switched on or off, or a setting changed.
    refresh() {
      if (!enabled()) video.pause();
      applyChime();
      changed();
      act();
    },
    snapshot,
    // The computer woke from sleep: the camera connection is most likely dead, so don't wait for
    // the silence check to notice.
    wake() {
      if (disposed) return;
      previous = null;
      // The time asleep wasn't the camera's fault.
      health.failures = {};
      health.lastCameraAt = Date.now();
      if (socket) { note("woke, reconnecting"); socket.terminate(); }
      pollEvents();
    },
    dispose() {
      disposed = true;
      clearTimeout(reconnectTimer);
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      video.stop();
      socket?.close();
      socket = null;
    },
  };
}
