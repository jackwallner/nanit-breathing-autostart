// The app's engine: Nanit sign-in, then one monitor per baby with a camera. Knows nothing about
// windows or menus; the Electron main process (src/main) shows what it reports.
import { HEADERS } from "./endpoints.js";
import { finishSignIn, nanitTokens, SignedOutError, SignInError, startSignIn } from "./auth.js";
import { createMonitor, TIMING } from "./monitor.js";

const SETUP_RETRY = 60_000;
const ACTIVITY_KEEP = 100;

// store: { loadTokens, saveTokens, clearTokens, loadActivity, saveActivity }
// settings(): { enabled(uid), holdAfterParentStop, silenceChime }
export function createService({ store, endpoints, ffmpegBin, videoInput, timing = TIMING, settings,
  log = () => {}, onUpdate = () => {}, onProblem = () => {} }) {
  const state = { account: "signed-out", user: null, babies: [], activity: store.loadActivity?.() ?? [], error: null, setup: null };
  const monitors = new Map();
  let pending = null; // email, password and mfa token between the two sign-in steps, in memory only
  let setupTimer = null;
  const tokenStore = { load: async () => store.loadTokens(), save: async (pair) => store.saveTokens(pair) };
  const token = nanitTokens({ api: endpoints.api, store: tokenStore });

  const update = () => onUpdate(view());
  const view = () => ({
    account: state.account, user: state.user, error: state.error, setup: state.setup,
    babies: state.babies.map((b) => monitors.get(b.uid)?.snapshot() ?? { uid: b.uid, name: b.name, phase: "connecting", enabled: settings().enabled(b.uid) }),
    activity: state.activity.slice(0, 50),
  });

  const addActivity = (entry) => {
    state.activity = [entry, ...state.activity].slice(0, ACTIVITY_KEEP);
    store.saveActivity?.(state.activity);
    log("activity", entry);
    update();
  };

  const problems = new Map();
  const onChange = (snapshot) => {
    const had = problems.get(snapshot.uid);
    if (snapshot.problem && !had) onProblem(snapshot);
    problems.set(snapshot.uid, Boolean(snapshot.problem));
    update();
  };

  const api = async (url) => {
    let failed;
    for (const retry of [false, true]) {
      const auth = await token(retry ? { failed } : {});
      const response = await fetch(`${endpoints.api}${url}`, { headers: { ...HEADERS, Authorization: auth }, signal: AbortSignal.timeout(20_000) });
      if (response.status === 401 && !retry) { failed = auth; continue; }
      if (response.status === 401) throw new SignedOutError("Nanit ended this sign-in. Sign in again.");
      if (!response.ok) throw new Error(`Nanit ${url.split("?")[0]} returned ${response.status}.`);
      return response.json();
    }
  };

  const stopMonitors = () => {
    for (const monitor of monitors.values()) monitor.dispose();
    monitors.clear();
    problems.clear();
    clearTimeout(setupTimer);
  };

  const signedOut = (error) => {
    if (state.account === "signed-out") return;
    log("signed out", { error: String(error?.message ?? error) });
    stopMonitors();
    store.clearTokens();
    Object.assign(state, { account: "signed-out", user: null, babies: [], setup: null,
      error: error ? "Nanit signed you out. Sign in again to keep autostart running." : null });
    onProblem({ signedOut: true });
    update();
  };

  // Finds the babies and starts their monitors. Retries every minute while Nanit can't be reached.
  const setup = async () => {
    clearTimeout(setupTimer);
    try {
      const [{ user }, { babies = [] }] = await Promise.all([api("/user"), api("/babies")]);
      state.user = { id: user.id, name: [user.first_name, user.last_name].filter(Boolean).join(" ") || null, email: user.email ?? null };
      state.babies = babies.filter((b) => b.camera?.uid).map((b) => ({ uid: b.uid, name: b.name || "Baby", camera: { uid: b.camera.uid } }));
      state.setup = state.babies.length ? null : "No Nanit camera on this account yet. Set one up in the Nanit app, then reopen this app.";
      state.account = "signed-in";
      update();
      for (const baby of state.babies) {
        const monitor = createMonitor({ baby, userId: user.id, endpoints, token, ffmpegBin, videoInput, settings, timing, log,
          onChange, onActivity: addActivity, onSignedOut: signedOut });
        monitors.set(baby.uid, monitor);
        await monitor.start();
      }
      log("ready", { babies: state.babies.length });
    } catch (error) {
      if (error instanceof SignedOutError) return signedOut(error);
      log("setup failed", { error: String(error?.message ?? error).slice(0, 300) });
      state.account = "signed-in";
      state.setup = "Can't reach Nanit right now. Trying again every minute.";
      update();
      setupTimer = setTimeout(setup, SETUP_RETRY);
    }
  };

  const finish = async (pair) => {
    await store.saveTokens(pair);
    pending = null;
    state.error = null;
    await setup();
  };

  return {
    view,
    async resume() {
      if (!(await store.loadTokens())) { update(); return; }
      state.account = "signed-in";
      state.setup = "Connecting to Nanit...";
      update();
      await setup();
    },
    async signIn(email, password) {
      state.error = null;
      try {
        const result = await startSignIn({ api: endpoints.api, email, password });
        if (result.pair) return await finish(result.pair);
        pending = { email, password, mfaToken: result.mfaToken };
        state.account = "needs-code";
        update();
      } catch (error) {
        state.error = error instanceof SignInError ? error.message : "Something went wrong signing in. Try again.";
        log("sign in failed", { error: String(error?.message ?? error) });
        update();
      }
    },
    async submitCode(code) {
      if (!pending) { state.account = "signed-out"; return update(); }
      state.error = null;
      try {
        const result = await finishSignIn({ api: endpoints.api, ...pending, code });
        await finish(result.pair);
      } catch (error) {
        state.error = error instanceof SignInError ? error.message : "Something went wrong signing in. Try again.";
        update();
      }
    },
    cancelSignIn() {
      pending = null;
      Object.assign(state, { account: "signed-out", error: null });
      update();
    },
    signOut() {
      stopMonitors();
      store.clearTokens();
      pending = null;
      Object.assign(state, { account: "signed-out", user: null, babies: [], error: null, setup: null });
      update();
    },
    // A setting changed: monitors re-read settings().
    refresh() {
      for (const monitor of monitors.values()) monitor.refresh();
      update();
    },
    get active() { return state.account === "signed-in" && state.babies.some((b) => settings().enabled(b.uid)); },
    dispose: stopMonitors,
  };
}
