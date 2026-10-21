import assert from "node:assert/strict";
import test from "node:test";

import { AFTER_END, afterCheck, CHANGED, CHECK_GAP, decide, difference, duringSearch, HOURLY_CHECKS, IDLE_CHECK, MOVED, observe, presence, QUICK_END, SEARCH_CHECK, SEARCH_STOP } from "../src/engine/monitor.js";
import * as bmm from "../src/engine/protocol.js";

const running = (breathing = "NORMAL", sessionId = "abc") => ({ state: "RUNNING", breathing, bpm: 38, sessionId, stoppedBy: null });
const off = (state = "COMPLETED") => ({ state, breathing: null, bpm: null, sessionId: null, stoppedBy: null });
const T = 10 * 3_600_000;

test("the newest put-down or take-out in Nanit's feed wins (3 assertions)", () => {
  const events = [
    { key: "PUT_IN_BED", uid: "a", time: 100 },
    { key: "FELL_ASLEEP", uid: "b", time: 200 },
    { key: "REMOVED_ASLEEP", uid: "c", time: 300 },
    { key: "MOTION", uid: "d", time: 400 },
  ];
  assert.deepEqual(presence(events), { inBed: false, uid: "c", key: "REMOVED_ASLEEP", time: 300 });
  assert.equal(presence([...events, { key: "PUT_TO_SLEEP", uid: "e", time: 500 }]).inBed, true);
  assert.equal(presence([{ key: "MOTION", time: 1 }]), null);
});

test("a changed picture triggers a Breathing Wear check at most once a minute; a still one every 15 minutes (6 assertions)", () => {
  assert.ok(difference([10, 10, 10], [10, 30, 10]) >= CHANGED);
  assert.ok(difference([10, 10, 10], [11, 12, 10]) < CHANGED);
  const s = { status: off("OFF"), checkedAt: T, changedAt: T + 1, checks: [T] };
  assert.equal(decide(s, T + CHECK_GAP - 1), null);
  assert.deepEqual(decide(s, T + CHECK_GAP), { do: "check", reason: "movement" });
  assert.equal(decide({ ...s, changedAt: T - 1 }, T + IDLE_CHECK - 1), null);
  assert.deepEqual(decide({ ...s, changedAt: T - 1 }, T + IDLE_CHECK), { do: "check", reason: "idle" });
});

test("no checks while unsure of the camera, while a session runs, right after one ends, or past the hourly cap (4 assertions)", () => {
  const due = { status: off("OFF"), checkedAt: T, changedAt: T + 1, checks: [] };
  assert.equal(decide({ ...due, status: null }, T + CHECK_GAP), null);
  assert.equal(decide({ ...due, status: running(), sessionId: "abc" }, T + CHECK_GAP), null);
  assert.equal(decide({ ...due, endedAt: T + CHECK_GAP - 1 }, T + CHECK_GAP), null);
  assert.equal(decide({ ...due, checks: Array.from({ length: HOURLY_CHECKS }, (_, i) => T + i) }, T + CHECK_GAP), null);
});

test("the camera saying she's out of bed stops the session once, before Nanit's own dialog (2 assertions)", () => {
  const s = { status: running("BABY_NOT_IN_BED"), sessionId: "abc", ourStop: null };
  assert.deepEqual(decide(s, T), { do: "stop", sessionId: "abc", reason: "out of bed" });
  assert.equal(decide({ ...s, ourStop: "abc" }, T), null);
});

test("eight minutes without seeing the wear stops before the camera's own 10-minute out-of-crib end; breathing resets the clock; no-breathing never stops (5 assertions)", () => {
  // On 2026-10-20 the camera ended a session itself 9 min 54 s into the search, which pops Nanit's
  // full "Monitoring stopped" dialog. Our stop has to land well before that.
  assert.ok(SEARCH_STOP <= 8 * 60_000);
  const s = { status: off("OFF"), checkedAt: T + 1000 + SEARCH_STOP - 1 };
  observe(s, running("NORMAL"), T);
  observe(s, running("NO_PATTERN"), T + 1000);
  observe(s, running("INIT"), T + 2000);
  assert.equal(decide(s, T + 1000 + SEARCH_STOP - 1), null);
  assert.deepEqual(decide(s, T + 1000 + SEARCH_STOP), { do: "stop", sessionId: "abc", reason: "no Breathing Wear in view" });
  observe(s, running("WIGGLING"), T + 3000);
  assert.equal(decide(s, T + 1000 + SEARCH_STOP), null);
  observe(s, running("NO_BREATHING"), T + 4000);
  assert.equal(decide(s, T + 4000 + SEARCH_STOP), null);
});

test("while a session searches we look for the band every three minutes, within the hourly budget (5 assertions)", () => {
  const s = { status: off("OFF"), checkedAt: T - 3_600_000, checks: [] };
  observe(s, running("NORMAL"), T);
  observe(s, running("NO_PATTERN"), T + 1000);
  assert.equal(decide(s, T + 1000 + SEARCH_CHECK - 1), null);
  assert.deepEqual(decide(s, T + 1000 + SEARCH_CHECK), { do: "check", reason: "searching" });
  s.checkedAt = T + 1000 + SEARCH_CHECK;
  assert.equal(decide(s, T + 1000 + SEARCH_CHECK + CHECK_GAP), null);
  assert.deepEqual(decide(s, T + 1000 + 2 * SEARCH_CHECK), { do: "check", reason: "searching" });
  assert.equal(decide({ ...s, checks: Array.from({ length: HOURLY_CHECKS }, (_, i) => T + i) }, T + 1000 + 2 * SEARCH_CHECK), null);
});

test("a find during a search waits where the session started and restarts anywhere else, including a parent's session (4 assertions)", () => {
  const s = { startPoint: { x: 600, y: 600 } };
  assert.equal(duringSearch(s, null), null);
  assert.equal(duringSearch(s, { x: 600 + MOVED, y: 600 }), "wait");
  assert.equal(duringSearch(s, { x: 600, y: 600 + MOVED + 1 }), "restart");
  assert.equal(duringSearch({ startPoint: null }, { x: 600, y: 600 }), "restart");
});

test("a parent's session has no known point; ours keeps the one we started at (2 assertions)", () => {
  const s = { status: off("OFF"), ourStart: "ours", startPoint: { x: 1, y: 2 } };
  observe(s, running("NORMAL", "ours"), T);
  assert.deepEqual(s.startPoint, { x: 1, y: 2 });
  observe(s, off(), T + 1000);
  observe(s, running("NORMAL", "theirs"), T + 2000);
  assert.equal(s.startPoint, null);
});

test("a parent's stop holds autostart until the band leaves view, unless the parent turned the hold off (5 assertions)", () => {
  const s = { status: running(), sessionId: "abc", ourStop: null };
  assert.equal(observe(s, off(), T), "stopped by a parent");
  assert.equal(afterCheck(s, { x: 1, y: 1 }, T + AFTER_END), "held after a stop in the Nanit app");
  assert.equal(afterCheck(s, { x: 1, y: 1 }, T + AFTER_END, { holdAfterParentStop: false }), "start");
  assert.equal(afterCheck(s, null, T + AFTER_END), null);
  assert.equal(afterCheck(s, { x: 1, y: 1 }, T + 2 * AFTER_END), "start");
});

test("our own stop re-arms; a session we started that ends within minutes backs off, longer the second time; so does one that never saw breathing (6 assertions)", () => {
  const s = { status: off("OFF"), ourStart: "abc", ourStop: null };
  assert.equal(observe(s, running(), T), "started");
  s.ourStop = "abc";
  assert.equal(observe(s, off(), T + QUICK_END - 1), "ended (COMPLETED)");
  assert.equal(afterCheck(s, { x: 1, y: 1 }, T + AFTER_END), "backing off after a false start");
  observe(s, running("NORMAL", "def"), T + 20 * 60_000);
  s.ourStart = "def";
  observe(s, off("COMPLETED_AFTER_BABY_NOT_IN_BED"), T + 21 * 60_000);
  assert.equal(s.backoffUntil, T + 51 * 60_000);
  const blind = { status: off("OFF"), ourStart: "y", ourStop: "y" };
  observe(blind, running("INIT", "y"), T);
  observe(blind, off(), T + QUICK_END + SEARCH_STOP);
  assert.ok(blind.backoffUntil > T + QUICK_END + SEARCH_STOP);
  const long = { status: running(), sessionId: "x", ourStart: "x", ourStop: "x", startedAt: T, sawBreathing: true };
  observe(long, off(), T + QUICK_END);
  assert.equal(afterCheck(long, { x: 1, y: 1 }, T + QUICK_END + AFTER_END), "start");
});

test("start and stop encode the fields Nanit's app sends, and the chime-off setting, and camera replies decode (8 assertions)", () => {
  const start = bmm.fields(bmm.fields(bmm.start(7, { x: 660, y: 632, sessionId: "uved79ekd" }))[2][0]);
  assert.equal(start[1][0], 7);
  assert.equal(start[2][0], bmm.TYPE.PUT_STING_START);
  const body = bmm.fields(start[22][0]);
  assert.equal(new TextDecoder().decode(body[2][0]), bmm.LOGS_SERVER);
  assert.deepEqual(bmm.fields(body[5][0]), { 1: [660], 2: [632] });
  assert.equal(body[11][0], 1);

  const chime = bmm.fields(bmm.fields(bmm.chime(9, false))[2][0]);
  assert.equal(chime[2][0], bmm.TYPE.PUT_SETTINGS);
  assert.deepEqual(bmm.fields(bmm.fields(chime[5][0])[22][0]), { 9: [0] });

  // A RUNNING status push as the camera sends it: Message{type REQUEST, request{id, PUT_STING_STATUS, stingStatus}}.
  const status = Uint8Array.from([0x08, 0x02, 0x10, 0x01, 0x50, 0x26, 0x62, 0x03, 0x61, 0x62, 0x63]);
  const request = Uint8Array.from([0x08, 0x05, 0x10, 0x20, 0xba, 0x01, status.length, ...status]);
  const message = Uint8Array.from([0x08, 0x01, 0x12, request.length, ...request]);
  assert.deepEqual(bmm.parse(message), { kind: "request", id: 5, type: 32, status: { state: "RUNNING", breathing: "NORMAL", bpm: 38, sessionId: "abc", stoppedBy: null } });
});

test("the pattern box's centre is where the camera looks; no detection means no start (2 assertions)", async () => {
  const box = { bmm_sessions: { detected: true, data: { objects: [{ box: { x1: 585.0, x2: 736.0, y1: 534.0, y2: 731.0 }, score: 0.55 }] } } };
  const found = await bmm.findPattern({ api: "https://api", token: "t", babyUid: "1", png: new Uint8Array([1]), infrared: false, width: 1920, height: 1080, fetcher: async () => Response.json(box) });
  assert.deepEqual([found.x, found.y, found.score], [660, 632, 0.55]);
  const none = await bmm.findPattern({ api: "https://api", token: "t", babyUid: "1", png: new Uint8Array([1]), infrared: true, fetcher: async () => Response.json({ bmm_sessions: { detected: false, data: { objects: [] } } }) });
  assert.equal(none, null);
});

test("invalid pattern coordinates cannot start a missing-wear session", async () => {
  for (const box of [
    { x1: -200, x2: -72, y1: 100, y2: 168 },
    { x1: 20, x2: 10, y1: 100, y2: 168 },
    { x1: 20, x2: 2000, y1: 100, y2: 168 },
    { x1: 20, x2: 100, y1: -1, y2: 168 },
    { x1: 20, x2: 100, y1: 100, y2: 1200 },
    { x1: "invalid", x2: 100, y1: 100, y2: 168 },
  ]) {
    const found = await bmm.findPattern({ api: "https://api", token: "t", babyUid: "1", png: new Uint8Array([1]),
      infrared: false, width: 1920, height: 1080,
      fetcher: async () => Response.json({ bmm_sessions: { detected: true, data: { objects: [{ box, score: 0.9 }] } } }),
    });
    assert.equal(found, null, JSON.stringify(box));
  }
});

test("what the window shows: problems first, then connection, session and autostart", async () => {
  const { phase, problem, PROBLEM_COUNT, PROBLEM_FOR, CAMERA_SILENCE } = await import("../src/engine/monitor.js");
  assert.equal(phase({ enabled: true, status: null, connected: false }), "connecting");
  assert.equal(phase({ enabled: true, status: off("OFF"), connected: true }), "watching");
  assert.equal(phase({ enabled: false, status: off("OFF"), connected: true }), "off");
  assert.equal(phase({ enabled: true, status: running(), connected: true }), "monitoring");
  assert.equal(phase({ enabled: true, status: running("NO_PATTERN"), connected: true }), "searching");
  assert.equal(phase({ enabled: true, status: running(), connected: true, problem: {} }), "problem");
  const failures = { watch: { since: T, count: PROBLEM_COUNT, error: "no video" } };
  assert.equal(problem({ failures, lastCameraAt: T }, T + PROBLEM_FOR - 1), null);
  assert.equal(problem({ failures, lastCameraAt: T }, T + PROBLEM_FOR).stage, "watch");
  assert.equal(problem({ failures: {}, connectedAt: T, lastCameraAt: T }, T + CAMERA_SILENCE).stage, "camera connection");
});

test("a dropped camera connection mid-session is the same session carrying on, not a new start (4 assertions)", () => {
  const s = { status: off("OFF"), ourStart: "abc" };
  assert.equal(observe(s, running("NORMAL"), T), "started");
  s.status = null; // the socket closed
  assert.equal(observe(s, running("NORMAL"), T + 3_600_000), null);
  assert.equal(s.startedAt, T);
  // Picked up a minute after the reconnect: an hour-long session, so no false-start back-off.
  observe(s, off("COMPLETED"), T + 3_660_000);
  assert.equal(s.backoffUntil, undefined);
});

test("a session that ended while the connection was down still counts as ended (3 assertions)", () => {
  const s = { status: off("OFF"), ourStart: "abc", ourStop: null };
  observe(s, running("NORMAL"), T);
  s.status = null;
  assert.equal(observe(s, off("COMPLETED"), T + 600_000), "stopped by a parent");
  assert.equal(s.endedAt, T + 600_000);
  assert.equal(observe(s, off("COMPLETED"), T + 700_000), null);
});

test("a new session seen after a reconnect is a new start (1 assertion)", () => {
  const s = { status: off("OFF"), ourStart: "abc" };
  observe(s, running("NORMAL", "abc"), T);
  s.status = null;
  assert.equal(observe(s, running("NORMAL", "xyz"), T + 600_000), "started");
});

test("a check that found nothing while the baby was being settled gets one more two minutes later, then waits (3 assertions)", () => {
  const s = { status: off("OFF"), checkedAt: T, changedAt: T - 10_000, checks: [T], lastFound: false };
  assert.equal(decide(s, T + 2 * 60_000 - 1), null);
  assert.deepEqual(decide(s, T + 2 * 60_000), { do: "check", reason: "settling" });
  // After that one, a still picture waits for the idle check.
  assert.equal(decide({ ...s, checkedAt: T + 2 * 60_000, checks: [T, T + 2 * 60_000] }, T + 4 * 60_000), null);
});

test("restarting a session in a new spot isn't a false start (1 assertion)", () => {
  const s = { status: off("OFF"), ourStart: "abc" };
  observe(s, running("NORMAL", "abc"), T);
  s.restarting = "abc"; s.ourStop = "abc";
  observe(s, off("COMPLETED"), T + 60_000);
  assert.equal(s.backoffUntil, undefined);
});
