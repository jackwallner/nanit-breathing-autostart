// Drives the real app window against the fake Nanit: sign in with a code, watch autostart start
// and stop monitoring, change a setting, sign out. Runs the source checkout by default, or a
// packaged build with BA_APP=<path to the executable>. BA_SHOTS=<dir> saves screenshots.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";

import { CODE, PASSWORD, startFakeNanit } from "./fake-nanit.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.env.BA_SHOTS;

// The window's own pixels (2x), as the app draws them.
async function shot(app, page, name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.waitForTimeout(300);
  // Screenshots are a by-product: some CI Macs have no GPU to capture with.
  try {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await writeFile(path.join(shots, `${name}.png`), Buffer.from(png, "base64"));
  } catch (error) { console.log(`No screenshot ${name}: ${error.message}`); }
}

async function until(what, fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ffmpeg processes reading the test clip, still running.
function readers() {
  if (process.platform === "win32") {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: "utf8" });
    return out.split(/\r?\n/).filter((line) => line.includes("camera.flv")).length;
  }
  try { return execFileSync("pgrep", ["-f", "fixtures/camera.flv"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length; }
  catch { return 0; } // pgrep exits 1 when nothing matches
}

const testEnv = (fake, userData) => {
  const env = {
    ...process.env, BA_TEST: "1", BA_USER_DATA: userData,
    BA_TEST_ENDPOINTS: JSON.stringify(fake.endpoints),
    BA_TEST_TIMING: JSON.stringify({ watch: 300, events: 1_000, status: 500, silentSocket: 5_000, reconnect: 300, reconnectAfterError: 300 }),
    BA_TEST_VIDEO: path.join(root, "test/fixtures/camera.flv"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};
const launch = (env, args = []) => electron.launch(process.env.BA_APP ? { executablePath: process.env.BA_APP, args, env } : { args: [root, ...args], env, cwd: root });

test("a parent signs in, autostart starts and stops monitoring, settings stick, sign out clears the session", { timeout: 180_000 }, async () => {
  const fake = await startFakeNanit();
  const userData = await mkdtemp(path.join(tmpdir(), "breathing-autostart-"));
  const app = await launch(testEnv(fake, userData), shots ? ["--force-device-scale-factor=2"] : []);
  try {
    const page = await app.firstWindow();
    await page.setViewportSize?.({ width: 420, height: 680 });
    await page.getByRole("heading", { name: "Hands-free breathing monitoring" }).waitFor();
    await shot(app, page, "1-sign-in");

    await page.getByLabel("Nanit email").fill("parent@example.com");
    await page.getByLabel("Password").fill("not it");
    await page.getByRole("button", { name: "Sign in with Nanit" }).click();
    await page.getByText("That email and password didn't work with Nanit.").waitFor();

    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in with Nanit" }).click();
    await page.getByRole("heading", { name: "Enter Nanit's code" }).waitFor();
    await shot(app, page, "2-code");
    await page.getByRole("button", { name: "Send a new code" }).click();
    await page.getByText("Nanit sent a new code.").waitFor();
    await page.getByLabel("Code").fill("0000");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText(/That code didn't work/).waitFor();
    await page.getByLabel("Code").fill(CODE);
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("heading", { name: "Hazel" }).waitFor();
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 20_000 });
    await shot(app, page, "3-ready");

    fake.bandVisible = true;
    await page.getByText("Monitoring breathing", { exact: true }).waitFor({ timeout: 90_000 });
    await page.getByText(/38 breaths\/min/).waitFor();
    assert.equal(fake.starts.length, 1);
    await shot(app, page, "4-monitoring");

    fake.babyOut();
    await page.getByText("Stopped monitoring: baby out of bed").waitFor({ timeout: 20_000 });
    assert.equal(fake.stops.length, 1);

    // Autostart off for Hazel survives in settings.json.
    await page.getByLabel("Autostart for Hazel").uncheck();
    await page.getByText("Autostart is off").waitFor();
    const saved = JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"));
    assert.equal(saved.disabled.b1, true);
    await page.getByLabel("Autostart for Hazel").check();
    await page.getByText("Ready", { exact: true }).waitFor();

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("heading", { name: "Settings" }).waitFor();
    await page.getByText("Signed in as parent@example.com").waitFor();
    await shot(app, page, "5-settings");
    await page.getByRole("checkbox", { name: /Silence the camera's chime/ }).check();
    const after = JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"));
    assert.equal(after.silenceChime, true);
    await until("the chime off on the camera", () => fake.chimes.at(-1) === false);

    // The saved session holds only tokens, never the password.
    const session = await readFile(path.join(userData, "session.bin"), "utf8");
    assert.equal(session.includes(PASSWORD), false);

    await page.getByRole("button", { name: "Done" }).click();
    await page.getByText("Recent activity").waitFor();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Hands-free breathing monitoring" }).waitFor();
    await assert.rejects(readFile(path.join(userData, "session.bin")));
  } finally {
    await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => {});
    await app.close().catch(() => {});
    await fake.close();
  }
});

test("quitting stops the camera reader, a second copy doesn't start, and the next launch is still signed in", { timeout: 240_000 }, async () => {
  const fake = await startFakeNanit();
  const userData = await mkdtemp(path.join(tmpdir(), "breathing-autostart-"));
  const env = testEnv(fake, userData);
  let app = await launch(env);
  try {
    let page = await app.firstWindow();
    await page.getByLabel("Nanit email").fill("parent@example.com");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in with Nanit" }).click();
    await page.getByLabel("Code").fill(CODE);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 20_000 });
    await until("the camera reader", () => readers() >= 1, 20_000);

    // A second copy hands over to the first and quits without connecting to the camera.
    const sockets = fake.connections;
    const second = await launch(env).catch(() => null);
    if (second) await new Promise((resolve) => { second.process().once("exit", resolve); setTimeout(resolve, 10_000); });
    assert.equal(fake.connections, sockets);

    const closed = new Promise((resolve) => app.process().once("exit", resolve));
    await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
    await closed;
    await until("no camera reader left", () => readers() === 0, 10_000);

    app = await launch(env);
    page = await app.firstWindow();
    await page.getByRole("heading", { name: "Hazel" }).waitFor({ timeout: 20_000 });
  } finally {
    await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => {});
    await app.close().catch(() => {});
    await fake.close();
  }
});
