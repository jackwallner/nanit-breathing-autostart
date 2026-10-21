// Breathing Autostart's main process: one small window, a menu bar (or tray) icon, and the
// engine running in the background for as long as the app is open.
import { uptime } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerMonitor, powerSaveBlocker, safeStorage, shell, Tray } from "electron";
import updater from "electron-updater";

import { NANIT } from "../engine/endpoints.js";
import { ffmpegPath } from "../engine/ffmpeg-path.js";
import { TIMING } from "../engine/monitor.js";
import { createService } from "../engine/service.js";
import { createStore } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_URL = "https://jackwallner.com/breathing-autostart/";
const SOURCE_URL = "https://github.com/jackwallner/nanit-breathing-autostart";
const UPDATE_EVERY = 6 * 3_600_000;

// Test runs (test/app.e2e.js) point the app at the fake Nanit and their own data folder.
const TEST = process.env.BA_TEST === "1";
if (process.env.BA_USER_DATA) app.setPath("userData", process.env.BA_USER_DATA);
const endpoints = TEST && process.env.BA_TEST_ENDPOINTS ? JSON.parse(process.env.BA_TEST_ENDPOINTS) : NANIT;
const timing = TEST && process.env.BA_TEST_TIMING ? { ...TIMING, ...JSON.parse(process.env.BA_TEST_TIMING) } : TIMING;
const videoInput = TEST && process.env.BA_TEST_VIDEO ? () => ["-re", "-stream_loop", "-1", "-i", process.env.BA_TEST_VIDEO] : undefined;

// A second copy would watch the same cameras, so it just shows the first one's window and leaves.
const FIRST = app.requestSingleInstanceLock();
if (!FIRST) app.quit();
if (process.platform === "win32") app.setAppUserModelId("com.jackwallner.breathingautostart");

let win = null, tray = null, store = null, service = null, quitting = false, blocker = null;
let view = { account: "signed-out", babies: [], activity: [] };
let update = null; // { version } once an update is downloaded

const send = () => win?.webContents.send("state", { ...view, settings: store.settings(), version: app.getVersion(), update, platform: process.platform });

function settingsFor() {
  const s = store.settings();
  return { enabled: (uid) => !s.disabled[uid], holdAfterParentStop: s.holdAfterParentStop, silenceChime: s.silenceChime };
}

// Keeps the computer from sleeping while autostart has a camera to watch. The screen may sleep.
function keepAwake() {
  const want = service?.active;
  if (want && blocker === null) blocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!want && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
}

function applyLoginItem() {
  if (TEST || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: store.settings().openAtLogin, args: process.platform === "win32" ? ["--hidden"] : [] });
}

const STATUS = {
  monitoring: "Monitoring breathing", searching: "Monitoring, Breathing Wear out of view", watching: "Ready",
  off: "Autostart off", connecting: "Connecting", problem: "Can't reach the camera",
};

function trayStatus() {
  if (view.account !== "signed-in") return "Not signed in";
  if (!view.babies.length) return view.setup ?? "Connecting";
  return view.babies.map((b) => `${view.babies.length > 1 ? `${b.name}: ` : ""}${STATUS[b.phase] ?? "Connecting"}`).join(" · ");
}

function refreshTray() {
  if (!tray) return;
  const status = trayStatus();
  tray.setToolTip(`Breathing Autostart: ${status}`);
  const allOff = view.babies.length > 0 && view.babies.every((b) => !b.enabled);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: "separator" },
    ...(view.account === "signed-in" && view.babies.length ? [{
      label: "Autostart", type: "checkbox", checked: !allOff,
      click: (item) => setEnabled(view.babies.map((b) => b.uid), item.checked),
    }, { type: "separator" }] : []),
    { label: "Open Breathing Autostart", click: showWindow },
    ...(update ? [{ label: `Restart to update to ${update.version}`, click: installUpdate }] : []),
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
}

function setEnabled(uids, on) {
  const disabled = { ...store.settings().disabled };
  for (const uid of uids) { if (on) delete disabled[uid]; else disabled[uid] = true; }
  store.setSettings({ disabled });
  service.refresh();
  keepAwake();
}

function createWindow({ show }) {
  win = new BrowserWindow({
    width: 420, height: 680, minWidth: 380, minHeight: 560, show: false,
    title: "Breathing Autostart",
    backgroundColor: "#00000000",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    autoHideMenuBar: true,
    icon: process.platform === "win32" ? path.join(here, "assets/icon.png") : undefined,
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.removeMenu?.();
  win.loadFile(path.join(here, "../renderer/index.html"));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => { if (show) showWindow(); });
  win.webContents.on("did-finish-load", send);
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (process.platform === "darwin") app.dock?.hide();
    // The first time, say where the app went.
    if (!store.settings().toldAboutTray && view.account === "signed-in" && Notification.isSupported()) {
      store.setSettings({ toldAboutTray: true });
      const where = process.platform === "darwin" ? "menu bar" : "system tray";
      new Notification({ title: "Breathing Autostart is still running", body: `It keeps working in the ${where}. Click its icon to open it.` }).show();
    }
  });
}

// Test runs keep the window hidden so they never take over the screen (BA_TEST_SHOW=1 shows it).
const HIDDEN_TEST = TEST && process.env.BA_TEST_SHOW !== "1";

function showWindow() {
  if (!win || HIDDEN_TEST) return;
  if (process.platform === "darwin") app.dock?.show();
  win.show();
  win.focus();
}

function notify(title, body) {
  if (!store.settings().notifyProblems || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on("click", showWindow);
  n.show();
}

function onProblem(problem) {
  if (problem.signedOut) return notify("Sign in to Nanit again", "Nanit ended the sign-in, so autostart is paused. Open Breathing Autostart to sign in.");
  notify(`Autostart can't reach ${problem.name}'s camera`, "It keeps retrying. Start monitoring from the Nanit app until it's back.");
}

function setupUpdates() {
  if (TEST || !app.isPackaged) return;
  const { autoUpdater } = updater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => { update = { version: info.version }; send(); refreshTray(); });
  autoUpdater.on("error", (error) => store.log("update failed", { error: String(error?.message ?? error).slice(0, 300) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_EVERY);
}

function installUpdate() {
  quitting = true;
  updater.autoUpdater.quitAndInstall();
}

const trayIcon = () => {
  if (process.platform === "darwin") {
    const image = nativeImage.createFromPath(path.join(here, "assets/trayTemplate.png"));
    image.setTemplateImage(true);
    return image;
  }
  return nativeImage.createFromPath(path.join(here, "assets/tray.png"));
};

function registerIpc() {
  ipcMain.handle("sign-in", (_e, { email, password }) => service.signIn(String(email ?? "").trim(), String(password ?? "")));
  ipcMain.handle("code", (_e, code) => service.submitCode(String(code ?? "").replace(/\D/g, "")));
  ipcMain.handle("cancel-sign-in", () => service.cancelSignIn());
  ipcMain.handle("sign-out", () => { service.signOut(); keepAwake(); });
  ipcMain.handle("set-enabled", (_e, { uid, on }) => setEnabled([String(uid)], Boolean(on)));
  ipcMain.handle("set-setting", (_e, { key, value }) => {
    if (!["holdAfterParentStop", "silenceChime", "openAtLogin", "notifyProblems"].includes(key)) return;
    store.setSettings({ [key]: Boolean(value) });
    if (key === "openAtLogin") applyLoginItem();
    service.refresh();
    send();
  });
  ipcMain.handle("open", (_e, what) => {
    if (what === "project") shell.openExternal(PROJECT_URL);
    if (what === "source") shell.openExternal(SOURCE_URL);
    if (what === "logs") shell.openPath(path.dirname(store.files.log));
  });
  ipcMain.handle("install-update", installUpdate);
  ipcMain.handle("check-updates", async () => {
    if (TEST || !app.isPackaged) return { status: "dev" };
    try {
      const result = await updater.autoUpdater.checkForUpdates();
      const latest = result?.updateInfo?.version;
      return { status: latest && latest !== app.getVersion() ? "downloading" : "current", version: latest };
    } catch { return { status: "failed" }; }
  });
}

app.on("second-instance", showWindow);
app.on("activate", showWindow);
app.on("before-quit", () => { quitting = true; });
// Stops the camera connections and ffmpeg readers, so nothing outlives the app (on Windows a
// leftover ffmpeg.exe would also block an update from replacing it).
app.on("will-quit", () => service?.dispose());
app.on("window-all-closed", (event) => event.preventDefault?.());

app.whenReady().then(async () => {
  if (!FIRST) return;
  const crypto = !TEST && safeStorage.isEncryptionAvailable()
    ? { encrypt: (text) => safeStorage.encryptString(text), decrypt: (buffer) => safeStorage.decryptString(buffer) }
    : null;
  store = createStore(app.getPath("userData"), crypto);
  store.log("launch", { version: app.getVersion(), platform: process.platform, arch: process.arch });

  service = createService({
    store, endpoints, timing, videoInput, settings: settingsFor,
    ffmpegBin: ffmpegPath(app.isPackaged ? process.resourcesPath : undefined),
    log: (what, extra) => store.log(what, extra),
    onUpdate: (next) => { view = next; send(); refreshTray(); keepAwake(); },
    onProblem,
  });
  registerIpc();

  tray = new Tray(trayIcon());
  if (process.platform !== "darwin") tray.on("click", showWindow);
  refreshTray();

  // macOS 13 and later don't always say the app was opened at login, so a launch in the first
  // minutes after startup counts as one too.
  const atLogin = process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAtLogin
    || (process.platform === "darwin" && store.settings().openAtLogin && uptime() < 300);
  const signedIn = Boolean(store.loadTokens());
  createWindow({ show: !(atLogin && signedIn) });
  if (((atLogin && signedIn) || HIDDEN_TEST) && process.platform === "darwin") app.dock?.hide();

  powerMonitor.on("resume", () => { store.log("resumed"); service.wake(); });

  applyLoginItem();
  setupUpdates();
  await service.resume();
});
