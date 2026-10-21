// Nanit's camera control protocol, just the parts that start and stop Breathing Motion
// monitoring. Field numbers come from Nanit's Android app (nanit.mobile.core.connect.nanit.proto).
// The camera is reached through Nanit's cloud relay, so this works from any computer.
export const LOGS_SERVER = "breathing-logs.nanit.com:24224";

export const MESSAGE = { KEEPALIVE: 0, REQUEST: 1, RESPONSE: 2 };
export const TYPE = { PUT_STREAMING: 2, PUT_SETTINGS: 5, PUT_STING_START: 30, PUT_STING_STOP: 31, PUT_STING_STATUS: 32, PUT_KEEP_ALIVE: 35, GET_STING_STATUS: 36 };
export const STATE = ["OFF", "INITING", "RUNNING", "PAUSED", "RESUMING", "INIT_FAILED", "COMPLETED", "ABORTED", "STALE", "COMPLETED_AFTER_INIT_FAILED", "COMPLETED_AFTER_BABY_NOT_IN_BED"];
export const BREATHING = ["LACK_TEXTURE", "NORMAL", "WIGGLING", "NO_PATTERN", "NO_BREATHING", "LOW_BPM", "HIGH_BPM", "INIT", "PATTERN_FOUND", "BABY_NOT_IN_BED"];
// A session is live in these states; anything else means monitoring is off.
export const LIVE = new Set(["INITING", "RUNNING", "PAUSED", "RESUMING"]);

// Protobuf wire format, only what these messages use: varints and length-delimited fields.
function varint(value) {
  const bytes = [];
  let n = BigInt.asUintN(64, BigInt(value));
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    bytes.push(byte);
  } while (n);
  return bytes;
}

const field = (tag, wire, body) => [...varint((tag << 3) | wire), ...body];
const int = (tag, value) => (value === undefined || value === null ? [] : field(tag, 0, varint(value)));
const bytes = (tag, body) => (body === undefined || body === null ? [] : field(tag, 2, [...varint(body.length), ...body]));
const text = (tag, value) => (value === undefined || value === null ? [] : bytes(tag, [...new TextEncoder().encode(value)]));

// Decodes one message level into { tag: [values] }; nested messages stay as byte arrays.
export function fields(buffer) {
  const out = {};
  let at = 0;
  const read = () => {
    let shift = 0n, n = 0n, byte;
    do {
      if (at >= buffer.length) throw new Error("Truncated Nanit message.");
      byte = buffer[at++];
      n |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    return n;
  };
  while (at < buffer.length) {
    const key = Number(read());
    const tag = key >> 3, wire = key & 7;
    let value;
    if (wire === 0) value = Number(read());
    else if (wire === 2) { const length = Number(read()); value = buffer.subarray(at, at + length); at += length; }
    else if (wire === 5) { value = buffer.subarray(at, at + 4); at += 4; }
    else if (wire === 1) { value = buffer.subarray(at, at + 8); at += 8; }
    else throw new Error(`Unknown wire type ${wire}.`);
    (out[tag] ??= []).push(value);
  }
  return out;
}

const first = (decoded, tag) => decoded[tag]?.[0];
const string = (value) => (value === undefined ? undefined : new TextDecoder().decode(value));

const request = (id, type, body = []) => Uint8Array.from([...int(1, MESSAGE.REQUEST), ...bytes(2, [...int(1, id), ...int(2, type), ...body])]);

export const getStatus = (id) => request(id, TYPE.GET_STING_STATUS);

// x, y: the Breathing Wear pattern's centre in camera frame pixels. The app always asks the
// camera to watch for the baby leaving the bed (enableBabyNotInBed), so this does too.
export function start(id, { x, y, sessionId }) {
  const point = [...int(1, x), ...int(2, y)];
  const body = [...text(2, LOGS_SERVER), ...bytes(5, point), ...text(8, sessionId), ...int(11, 1)];
  return request(id, TYPE.PUT_STING_START, bytes(22, body));
}

// Camera's breathing-monitoring settings (Settings.sting, field 22): chime (9) is the sound the
// camera plays when a session starts or stops. The breathing alarm is alertSound (2), left alone.
export const chime = (id, on) => request(id, TYPE.PUT_SETTINGS, bytes(5, bytes(22, int(9, on ? 1 : 0))));

// Asks the camera to push its picture to Nanit's RTMPS relay (Streaming: id MOBILE = 2, status STARTED = 0).
export const streaming = (id, rtmpUrl) => request(id, TYPE.PUT_STREAMING, bytes(4, [...int(1, 2), ...int(2, 0), ...text(3, rtmpUrl)]));

export const stop = (id, userId) => request(id, TYPE.PUT_STING_STOP, bytes(33, text(1, String(userId))));

// The camera pushes status (and sensor data) as requests and expects a response with the same id.
export const ack = (id, type) => Uint8Array.from([...int(1, MESSAGE.RESPONSE), ...bytes(3, [...int(1, id), ...int(2, type), ...int(3, 200)])]);

export const keepAlive = () => Uint8Array.from(int(1, MESSAGE.KEEPALIVE));

function status(raw) {
  if (!raw) return null;
  const s = fields(raw);
  return {
    state: STATE[first(s, 1) ?? 0] ?? String(first(s, 1)),
    breathing: first(s, 2) === undefined ? null : BREATHING[first(s, 2)] ?? String(first(s, 2)),
    bpm: first(s, 10) ?? null,
    sessionId: string(first(s, 12)) ?? null,
    stoppedBy: string(first(s, 16)) ?? null,
  };
}

// Turns a socket frame into { kind, id, type, statusCode, status }.
export function parse(buffer) {
  const message = fields(buffer);
  const kind = first(message, 1) ?? MESSAGE.KEEPALIVE;
  if (kind === MESSAGE.REQUEST && first(message, 2)) {
    const r = fields(first(message, 2));
    return { kind: "request", id: first(r, 1), type: first(r, 2), status: status(first(r, 23)) };
  }
  if (kind === MESSAGE.RESPONSE && first(message, 3)) {
    const r = fields(first(message, 3));
    return { kind: "response", id: first(r, 1), type: first(r, 2), statusCode: first(r, 3) ?? null, statusMessage: string(first(r, 4)) ?? null, status: status(first(r, 21)) };
  }
  return { kind: "keepalive" };
}

// Same shape as the app's Randomizer.getRandomSessionId: 50 random bits in base 32.
export function sessionId() {
  const random = crypto.getRandomValues(new Uint8Array(7));
  let n = 0n;
  for (const byte of random) n = (n << 8n) | BigInt(byte);
  return (n & ((1n << 50n) - 1n)).toString(32);
}

// Nanit's server finds the Breathing Wear pattern in a camera frame (PNG) and returns its box.
export async function findPattern({ api, token, babyUid, png, infrared, width, height, fetcher = fetch }) {
  const form = new FormData();
  form.append("image", new Blob([png], { type: "image/png" }), "image");
  form.append("camera_status", infrared ? "ir" : "rgb");
  const response = await fetcher(`${api}/focus/babies/${babyUid}/bmm/sessions`, {
    method: "POST", body: form, signal: AbortSignal.timeout(30_000),
    headers: { Authorization: token, "nanit-api-version": "1" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Nanit's pattern check failed (HTTP ${response.status}).`);
  const session = body.bmm_sessions;
  const points = session?.data?.objects?.[0]?.box;
  if (!session?.detected || !points) return null;
  const coordinates = [points.x1, points.x2, points.y1, points.y2].map((value) => Number.parseFloat(value));
  if (!coordinates.every(Number.isFinite) || !Number.isInteger(width) || !Number.isInteger(height)) return null;
  const [x1, x2, y1, y2] = coordinates;
  // The finder sometimes claims a detection outside the image. Sending that point starts a
  // session that immediately fails and raises Nanit's missing-wear dialog on other devices.
  if (x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1 || x2 > width || y2 > height) return null;
  return { x: Math.trunc((x1 + x2) / 2), y: Math.trunc((y1 + y2) / 2), box: { x1, x2, y1, y2 }, score: session.data.objects[0].score };
}
