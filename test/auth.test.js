import assert from "node:assert/strict";
import test from "node:test";

import { expiresAt, finishSignIn, nanitTokens, SignedOutError, SignInError, startSignIn } from "../src/engine/auth.js";

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
const NOW = 1_800_000_000_000;
const now = () => NOW;
const API = "https://api.example";

const memory = (pair = null) => {
  const store = { pair, saves: 0, load: async () => store.pair, save: async (p) => { store.pair = p; store.saves++; } };
  return store;
};

function refresher(calls, { status = 200 } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    const n = calls.length;
    return new Response(JSON.stringify(status === 200 ? { access_token: jwt(NOW / 1000 + 3600 + n), refresh_token: `refresh-${n}` } : {}), { status });
  };
}

test("expiry comes from the token's own exp, with a fallback when it can't be read", () => {
  assert.equal(expiresAt(jwt(1234), 0), 1_234_000);
  assert.equal(expiresAt("opaque", 1000), 1000 + 55 * 60_000);
});

test("a fresh token is used as is; a nearly expired one is refreshed once, even when asked twice at once", async () => {
  const calls = [];
  const token = nanitTokens({ api: API, store: memory({ accessToken: jwt(NOW / 1000 + 3600), refreshToken: "refresh-0", obtainedAt: NOW }), fetcher: refresher(calls), now });
  assert.equal(await token(), jwt(NOW / 1000 + 3600));
  assert.equal(calls.length, 0);

  const store = memory({ accessToken: jwt(NOW / 1000 + 60), refreshToken: "refresh-0", obtainedAt: NOW });
  const renew = nanitTokens({ api: API, store, fetcher: refresher(calls), now });
  const [a, b] = await Promise.all([renew(), renew()]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API}/tokens/refresh`);
  assert.equal(JSON.parse(calls[0].init.body).refresh_token, "refresh-0");
  assert.equal(store.pair.refreshToken, "refresh-1");
});

test("a 401'd token is refreshed", async () => {
  const calls = [];
  const first = jwt(NOW / 1000 + 3600);
  const token = nanitTokens({ api: API, store: memory({ accessToken: first, refreshToken: "refresh-0", obtainedAt: NOW }), fetcher: refresher(calls), now });
  assert.notEqual(await token({ failed: first }), first);
  assert.equal(calls.length, 1);
});

test("a refused refresh token or no saved sign-in means signed out, and never signs in by itself", async () => {
  const calls = [];
  await assert.rejects(nanitTokens({ api: API, store: memory({ accessToken: jwt(NOW / 1000), refreshToken: "dead", obtainedAt: NOW }), fetcher: refresher(calls, { status: 401 }), now })(), SignedOutError);
  assert.ok(calls.every((call) => !call.url.endsWith("/login")));
  await assert.rejects(nanitTokens({ api: API, store: memory(), fetcher: refresher(calls), now })(), SignedOutError);
});

test("sign-in asks for Nanit's code, then completes with it", async () => {
  const bodies = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.password !== "p") return Response.json({}, { status: 401 });
    if (!body.mfa_code) return Response.json({ mfa_token: "m" }, { status: 482 });
    if (body.mfa_code !== "1234") return Response.json({}, { status: 401 });
    return Response.json({ access_token: jwt(NOW / 1000 + 3600), refresh_token: "r" });
  };
  await assert.rejects(startSignIn({ api: API, email: "e", password: "wrong", fetcher, now }), (e) => e instanceof SignInError && /email and password/.test(e.message));
  const first = await startSignIn({ api: API, email: "e", password: "p", fetcher, now });
  assert.deepEqual(first, { mfaToken: "m" });
  await assert.rejects(finishSignIn({ api: API, email: "e", password: "p", mfaToken: "m", code: "0000", fetcher, now }), /code didn't work/);
  const done = await finishSignIn({ api: API, email: "e", password: "p", mfaToken: "m", code: "1234", fetcher, now });
  assert.equal(done.pair.refreshToken, "r");
  assert.deepEqual(bodies.at(-1), { email: "e", password: "p", mfa_token: "m", mfa_code: "1234" });
});

test("no network reads as a plain message", async () => {
  await assert.rejects(startSignIn({ api: API, email: "e", password: "p", fetcher: async () => { throw new TypeError("fetch failed"); } }), /internet connection/);
});
