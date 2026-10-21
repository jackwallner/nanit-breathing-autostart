// A stand-in for Nanit's API and camera relay, for the engine and app tests. It speaks the same
// HTTP routes and protobuf camera messages the app uses, with one baby, Hazel, on camera c1.
import { createServer } from "node:http";

import { WebSocketServer } from "ws";

import * as bmm from "../src/engine/protocol.js";

const varint = (value) => {
  const out = [];
  let n = BigInt(value);
  do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};
const int = (tag, v) => (v === undefined || v === null ? [] : [...varint((tag << 3) | 0), ...varint(v)]);
const bytes = (tag, body) => [...varint((tag << 3) | 2), ...varint(body.length), ...body];
const text = (tag, v) => (v === undefined || v === null ? [] : bytes(tag, [...new TextEncoder().encode(v)]));

const encodeStatus = ({ state, breathing, bpm, sessionId }) => [
  ...int(1, bmm.STATE.indexOf(state)), ...(breathing ? int(2, bmm.BREATHING.indexOf(breathing)) : []),
  ...int(10, bpm), ...text(12, sessionId),
];

export const PASSWORD = "correct horse";
export const CODE = "1234";

export async function startFakeNanit() {
  const fake = {
    tokens: new Map(), // access token -> refresh token
    refreshTokens: new Set(),
    bandVisible: false,
    status: { state: "OFF", breathing: null, bpm: null, sessionId: null },
    starts: [], stops: [], chimes: [], streams: [], finds: 0, logins: [],
    sockets: new Set(),
  };
  let counter = 0;
  const mint = () => {
    counter++;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.a${counter}`;
    const refresh = `r${counter}`;
    fake.tokens.set(access, refresh);
    fake.refreshTokens.add(refresh);
    return { access_token: access, refresh_token: refresh };
  };
  const authed = (req) => fake.tokens.has((req.headers.authorization ?? "").replace(/^Bearer /, ""));

  const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const body = (req) => new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const raw = await body(req);
    if (req.method === "POST" && url.pathname === "/login") {
      const login = JSON.parse(raw.toString() || "{}");
      fake.logins.push(login);
      if (login.password !== PASSWORD) return json(res, 401, { message: "Unauthorized" });
      if (!login.mfa_token) return json(res, 482, { mfa_token: "mfa-1" });
      if (login.mfa_code !== CODE) return json(res, 401, { message: "Wrong code" });
      return json(res, 201, mint());
    }
    if (req.method === "POST" && url.pathname === "/tokens/refresh") {
      const { refresh_token: refresh } = JSON.parse(raw.toString() || "{}");
      if (!fake.refreshTokens.delete(refresh)) return json(res, 401, {});
      return json(res, 201, mint());
    }
    if (!authed(req)) return json(res, 401, {});
    if (url.pathname === "/user") return json(res, 200, { user: { id: 42, first_name: "Test", last_name: "Parent", email: "parent@example.com" } });
    if (url.pathname === "/babies") return json(res, 200, { babies: [{ uid: "b1", name: "Hazel", camera: { uid: "c1" } }] });
    if (url.pathname === "/babies/b1/events") return json(res, 200, { events: [] });
    if (req.method === "POST" && url.pathname === "/focus/babies/b1/bmm/sessions") {
      fake.finds++;
      const detected = fake.bandVisible;
      return json(res, 200, { bmm_sessions: { detected, data: { objects: detected ? [{ box: { x1: "900", x2: "1000", y1: "500", y2: "600" }, score: 0.9 }] : [] } } });
    }
    json(res, 404, {});
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/cameras/c1/user_connect" || !authed(req)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      fake.sockets.add(ws);
      ws.on("close", () => fake.sockets.delete(ws));
      ws.on("message", (data) => {
        const message = bmm.fields(new Uint8Array(data));
        if (message[1]?.[0] !== bmm.MESSAGE.REQUEST) return;
        const r = bmm.fields(message[2][0]);
        const id = r[1][0], type = r[2][0];
        if (type === bmm.TYPE.PUT_STING_START) {
          const start = bmm.fields(r[22][0]);
          const point = bmm.fields(start[5][0]);
          const sessionId = new TextDecoder().decode(start[8][0]);
          fake.starts.push({ x: point[1][0], y: point[2][0], sessionId });
          respond(ws, id, type);
          setTimeout(() => fake.push({ state: "INITING", breathing: "INIT", bpm: null, sessionId }), 50);
          setTimeout(() => fake.push({ state: "RUNNING", breathing: "NORMAL", bpm: 38, sessionId }), 150);
        } else if (type === bmm.TYPE.PUT_STING_STOP) {
          fake.stops.push({ sessionId: fake.status.sessionId });
          respond(ws, id, type);
          setTimeout(() => fake.push({ state: "COMPLETED", breathing: null, bpm: null, sessionId: fake.status.sessionId }), 50);
        } else if (type === bmm.TYPE.PUT_SETTINGS) {
          fake.chimes.push(true);
          respond(ws, id, type);
        } else if (type === bmm.TYPE.PUT_STREAMING) {
          fake.streams.push(true);
          respond(ws, id, type);
        } else if (type === bmm.TYPE.GET_STING_STATUS) {
          respond(ws, id, type, fake.status);
        } else respond(ws, id, type);
      });
    });
  });

  const respond = (ws, id, type, status) => {
    const response = [...int(1, id), ...int(2, type), ...int(3, 200), ...(status ? bytes(21, encodeStatus(status)) : [])];
    ws.send(Uint8Array.from([...int(1, bmm.MESSAGE.RESPONSE), ...bytes(3, response)]));
  };

  // The camera pushes a status change to every connected app.
  fake.push = (status) => {
    fake.status = { ...status };
    const request = [...int(1, 5000 + counter++), ...int(2, bmm.TYPE.PUT_STING_STATUS), ...bytes(23, encodeStatus(status))];
    const message = Uint8Array.from([...int(1, bmm.MESSAGE.REQUEST), ...bytes(2, request)]);
    for (const ws of fake.sockets) ws.send(message);
  };
  fake.babyOut = () => fake.push({ ...fake.status, breathing: "BABY_NOT_IN_BED" });
  fake.parentStart = () => fake.push({ state: "RUNNING", breathing: "NORMAL", bpm: 40, sessionId: "parent1" });
  fake.parentStop = () => fake.push({ state: "COMPLETED", breathing: null, bpm: null, sessionId: fake.status.sessionId });
  fake.revokeAll = () => { fake.tokens.clear(); fake.refreshTokens.clear(); for (const ws of fake.sockets) ws.close(); };

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  fake.endpoints = { api: `http://127.0.0.1:${port}`, socket: `ws://127.0.0.1:${port}/cameras`, media: "file:fake" };
  fake.close = () => new Promise((resolve) => { for (const ws of fake.sockets) ws.terminate(); wss.close(); server.close(resolve); });
  return fake;
}
