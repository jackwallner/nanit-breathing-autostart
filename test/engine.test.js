// The whole engine against the fake Nanit, with the bundled ffmpeg reading a recorded clip.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ffmpegPath } from "../src/engine/ffmpeg-path.js";
import { createService } from "../src/engine/service.js";
import { CODE, PASSWORD, startFakeNanit } from "./fake-nanit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const clip = path.join(here, "fixtures/camera.flv");
const FAST = { watch: 300, events: 1_000, status: 500, silentSocket: 5_000, reconnect: 300, reconnectAfterError: 300 };

async function until(what, fn, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("sign in with Nanit's code, start when the band is in view, stop when the baby is out of bed, sign out when Nanit ends the sign-in", { timeout: 90_000 }, async () => {
  const fake = await startFakeNanit();
  let tokens = null;
  const store = { loadTokens: () => tokens, saveTokens: (pair) => { tokens = pair; }, clearTokens: () => { tokens = null; } };
  const settings = { enabled: () => true, holdAfterParentStop: true, silenceChime: true };
  let view = null, problems = [];
  const service = createService({
    store, endpoints: fake.endpoints, ffmpegBin: ffmpegPath(), timing: FAST, settings: () => settings,
    videoInput: () => ["-re", "-stream_loop", "-1", "-i", clip],
    log: (what, extra) => process.env.DEBUG && console.log(new Date().toISOString().slice(14, 23), what, JSON.stringify(extra ?? {})),
    onUpdate: (v) => { view = v; }, onProblem: (p) => problems.push(p),
  });
  try {
    await service.resume();
    assert.equal(service.view().account, "signed-out");

    await service.signIn("parent@example.com", "wrong");
    assert.equal(view.account, "signed-out");
    assert.match(view.error, /email and password/);

    await service.signIn("parent@example.com", PASSWORD);
    assert.equal(view.account, "needs-code");
    await service.submitCode("9999");
    assert.match(view.error, /code didn't work/);
    await service.submitCode(CODE);
    assert.equal(view.account, "signed-in");
    assert.equal(view.user.name, "Test Parent");
    assert.deepEqual(view.babies.map((b) => b.name), ["Hazel"]);
    assert.ok(tokens.refreshToken, "only tokens are kept");
    assert.equal(JSON.stringify(tokens).includes(PASSWORD), false);

    await until("the camera connection", () => view.babies[0].phase === "watching");
    await until("the chime setting", () => fake.chimes.length === 1);
    // The picture moves but there's no band: checks find nothing and nothing starts.
    await until("a Breathing Wear check", () => fake.finds >= 2);
    assert.equal(fake.starts.length, 0);

    fake.bandVisible = true;
    const started = await until("a start", () => fake.starts[0], 70_000);
    assert.deepEqual([started.x, started.y], [950, 550]);
    await until("monitoring", () => view.babies[0].phase === "monitoring" && view.babies[0].bpm === 38);
    assert.match(view.activity[0].text, /Started monitoring/);

    fake.babyOut();
    await until("a stop", () => fake.stops.length === 1);
    await until("watching again", () => view.babies[0].phase === "watching");
    assert.ok(view.activity.slice(0, 2).some((a) => /baby out of bed/.test(a.text)));
    // It lasted under three minutes, so it counts as a false start and autostart waits.
    assert.match(view.activity[0].text, /Waiting 10 minutes/);
    assert.ok(view.babies[0].backoffUntil > Date.now());

    fake.revokeAll();
    await until("signed out", () => view.account === "signed-out");
    assert.match(view.error, /Sign in again/);
    assert.equal(tokens, null);
    assert.ok(problems.some((p) => p.signedOut));
  } finally {
    service.dispose();
    await fake.close();
  }
});
