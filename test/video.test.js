import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import * as bmm from "../src/engine/protocol.js";
import { HEIGHT, infrared, nanitVideo, redact, streamInput, thumbnail, WIDTH } from "../src/engine/video.js";

const FRAME = WIDTH * HEIGHT * 3;
const input = streamInput("rtmps://media-secured.nanit.com/nanit");

function fakeSpawn(runs) {
  const calls = [];
  const spawn = (bin, args, options) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    proc.kill = () => proc.emit("exit", null, "SIGKILL");
    proc.pid = 1000 + calls.length;
    calls.push({ bin, args, options, proc });
    const run = runs[calls.length - 1];
    if (run) setImmediate(() => run(proc));
    return proc;
  };
  return { spawn, calls };
}

test("the thumbnail averages 60 x 60 blocks and night vision is told by missing colour", () => {
  const grey = Buffer.alloc(FRAME, 100);
  const t = thumbnail(grey);
  assert.equal(t.length, 32 * 18);
  assert.ok(t.every((v) => v === 100));
  assert.equal(infrared(grey), true);
  const colour = Buffer.alloc(FRAME);
  for (let i = 0; i < FRAME; i += 3) { colour[i] = 200; colour[i + 1] = 50; colour[i + 2] = 50; }
  assert.equal(infrared(colour), false);
});

test("ffmpeg errors never carry the access token", () => {
  assert.equal(redact("Error opening rtmps://media-secured.nanit.com/nanit/11325029.eyJ.abc.def: I/O"), "Error opening rtmps://media-secured.nanit.com/nanit/11325029.<token>: I/O");
});

test("frames split across pipe chunks come out whole; the stream URL uses the API token and certificates are checked", async () => {
  const { spawn, calls } = fakeSpawn([(proc) => {
    const frame = Buffer.alloc(FRAME, 7);
    proc.stdout.write(frame.subarray(0, 1000));
    proc.stdout.write(frame.subarray(1000));
  }]);
  const video = nanitVideo({ ffmpegBin: "/bin/ff", babyUid: "42", token: async () => "tok", input, spawn });
  const grey = await video.thumbnail();
  assert.ok(grey.every((v) => v === 7));
  assert.equal(calls[0].bin, "/bin/ff");
  assert.ok(calls[0].args.includes("rtmps://media-secured.nanit.com/nanit/42.tok"));
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf("-tls_verify"), calls[0].args.indexOf("-tls_verify") + 2), ["-tls_verify", "1"]);
  assert.ok(calls[0].args.includes(`fps=1,scale=${WIDTH}:${HEIGHT}`));
  assert.equal(calls[0].options.windowsHide, true);
  video.stop();
});

test("when ffmpeg gets nothing, the camera is asked to stream and ffmpeg starts again", async () => {
  let requested = 0;
  const { spawn, calls } = fakeSpawn([
    (proc) => { proc.stderr.write("Error opening input rtmps://x/nanit/42.secret-token"); proc.emit("exit", 1, null); },
    (proc) => proc.stdout.write(Buffer.alloc(FRAME, 9)),
  ]);
  const logs = [];
  const video = nanitVideo({ ffmpegBin: "/bin/ff", babyUid: "42", token: async () => "tok", input, spawn,
    requestStream: async () => { requested++; }, log: (what, extra) => logs.push({ what, ...extra }),
    setTimer: (fn) => setImmediate(fn) });
  const grey = await video.thumbnail();
  assert.equal(requested, 1);
  assert.ok(grey.every((v) => v === 9) && calls.length === 2);
  assert.equal(JSON.stringify(logs).includes("secret-token"), false);
  video.stop();
});

test("pausing kills the reader without asking the camera to stream or restarting; the next read resumes", async () => {
  let requested = 0;
  const { spawn, calls } = fakeSpawn([(proc) => proc.stdout.write(Buffer.alloc(FRAME, 3)), (proc) => proc.stdout.write(Buffer.alloc(FRAME, 4))]);
  const video = nanitVideo({ ffmpegBin: "/bin/ff", babyUid: "42", token: async () => "tok", input, spawn,
    requestStream: async () => { requested++; }, setTimer: (fn) => setImmediate(fn) });
  assert.ok((await video.thumbnail()).every((v) => v === 3));
  video.pause();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.equal(requested, 0);
  assert.ok((await video.thumbnail()).every((v) => v === 4));
  assert.equal(calls.length, 2);
  video.stop();
});

test("PUT_STREAMING asks for the MOBILE stream, STARTED, at the given URL", () => {
  const message = bmm.fields(bmm.streaming(7, "rtmps://relay/x"));
  const request = bmm.fields(message[2][0]);
  assert.equal(request[1][0], 7);
  assert.equal(request[2][0], bmm.TYPE.PUT_STREAMING);
  const streaming = bmm.fields(request[4][0]);
  assert.deepEqual([streaming[1][0], streaming[2][0]], [2, 0]);
  assert.equal(new TextDecoder().decode(streaming[3][0]), "rtmps://relay/x");
});

test("an ffmpeg that can't be started is retried, not wedged (3 assertions)", async () => {
  const timers = [];
  const { spawn, calls } = fakeSpawn([(proc) => { proc.pid = undefined; proc.emit("error", new Error("spawn EACCES")); }]);
  const video = nanitVideo({ ffmpegBin: "ffmpeg", babyUid: "42", token: async () => "t", input, spawn, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  await video.start();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(video.running, false);
  const retry = timers.find((t) => t.ms === 60_000);
  assert.ok(retry, "retried after a minute, without asking the camera to stream");
  retry.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  video.stop();
});
