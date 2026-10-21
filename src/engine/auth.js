// Nanit API tokens. Signing in takes the parent's email, password and the 4-digit code Nanit
// texts or emails; after that only the refresh token is kept (encrypted by the app), never the
// password. Nanit rotates the refresh token on every use, so refreshes are serialised.
import { HEADERS } from "./endpoints.js";

const EARLY = 5 * 60_000; // refresh this long before the access token runs out
const FALLBACK_LIFE = 55 * 60_000; // when the token's expiry can't be read

// Nanit refused the saved sign-in: the parent has to sign in again.
export class SignedOutError extends Error {}
// Wrong email, password or code: shown to the parent as is.
export class SignInError extends Error {}

export function expiresAt(token, obtainedAt) {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    if (Number.isFinite(exp)) return exp * 1000;
  } catch {}
  return obtainedAt + FALLBACK_LIFE;
}

const pairFrom = (body, now) => ({ accessToken: body.access_token, refreshToken: body.refresh_token, obtainedAt: now });

// store: { load(): pair | null, save(pair) }. token() gives a usable access token; after a 401,
// token({ failed }) refreshes unless the token that failed was already replaced.
export function nanitTokens({ api, store, fetcher = fetch, now = Date.now }) {
  let held = null;
  let refreshing = null;
  const fresh = (pair) => expiresAt(pair.accessToken, pair.obtainedAt) - now() > EARLY;

  const refresh = async () => {
    const current = await store.load();
    if (!current) throw new SignedOutError("Not signed in to Nanit.");
    let response;
    try {
      response = await fetcher(`${api}/tokens/refresh`, {
        method: "POST", signal: AbortSignal.timeout(20_000),
        headers: { ...HEADERS, "Content-Type": "application/json", Authorization: current.accessToken },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
      });
    } catch (error) { throw new Error(`Nanit didn't answer the token refresh: ${error?.message ?? error}`); }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new SignedOutError("Nanit ended this sign-in. Sign in again.");
    }
    if (!response.ok) throw new Error(`Nanit token refresh failed (HTTP ${response.status}).`);
    const body = await response.json();
    if (!body.access_token || !body.refresh_token) throw new Error("Nanit's token refresh answer had no tokens.");
    const pair = pairFrom(body, now());
    await store.save(pair);
    return pair;
  };

  return async ({ failed } = {}) => {
    if (!held || held.accessToken === failed || !fresh(held)) held = await store.load();
    if (!held) throw new SignedOutError("Not signed in to Nanit.");
    if (held.accessToken !== failed && fresh(held)) return held.accessToken;
    refreshing ??= refresh().finally(() => { refreshing = null; });
    held = await refreshing;
    return held.accessToken;
  };
}

async function post(api, body, fetcher) {
  let response;
  try {
    response = await fetcher(`${api}/login`, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { ...HEADERS, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch { throw new SignInError("Couldn't reach Nanit. Check your internet connection."); }
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// Step one: email and password. Nanit nearly always answers with a code request.
// Returns { pair } when no code is needed, or { mfaToken } when it is.
export async function startSignIn({ api, email, password, fetcher = fetch, now = Date.now }) {
  const { status, body } = await post(api, { email, password }, fetcher);
  if (body.access_token && body.refresh_token) return { pair: pairFrom(body, now()) };
  if (body.mfa_token) return { mfaToken: body.mfa_token };
  if (status === 401 || status === 403 || status === 400) throw new SignInError("That email and password didn't work with Nanit.");
  if (status === 429) throw new SignInError("Nanit says there were too many tries. Wait a few minutes and try again.");
  throw new SignInError(`Nanit couldn't sign you in (HTTP ${status}).`);
}

// Step two: the 4-digit code.
export async function finishSignIn({ api, email, password, mfaToken, code, fetcher = fetch, now = Date.now }) {
  const { status, body } = await post(api, { email, password, mfa_token: mfaToken, mfa_code: code }, fetcher);
  if (body.access_token && body.refresh_token) return { pair: pairFrom(body, now()) };
  if (status === 429) throw new SignInError("Nanit says there were too many tries. Wait a few minutes and try again.");
  throw new SignInError("That code didn't work. Check the latest code from Nanit and try again.");
}
