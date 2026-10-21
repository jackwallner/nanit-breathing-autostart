// What the app keeps on this computer, all in its own data folder:
//   settings.json  the parent's choices
//   session.bin    Nanit's API tokens, encrypted by the operating system (Keychain or DPAPI)
//   activity.json  the recent activity list
//   logs/          a small rotating log for troubleshooting (no tokens, no passwords)
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULTS = {
  disabled: {}, // baby uid -> true when autostart is off for that baby
  holdAfterParentStop: true,
  silenceChime: false,
  openAtLogin: true,
  notifyProblems: true,
  toldAboutTray: false,
};

const LOG_MAX = 2 * 1024 * 1024;

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJson = (file, value) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};

// crypto: { encrypt(string) -> Buffer, decrypt(Buffer) -> string } or null to store plain text
// (only the tests do that).
export function createStore(dir, crypto) {
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  const files = {
    settings: path.join(dir, "settings.json"),
    session: path.join(dir, "session.bin"),
    activity: path.join(dir, "activity.json"),
    log: path.join(dir, "logs", "autostart.log"),
  };
  let settings = { ...DEFAULTS, ...readJson(files.settings, {}) };
  let activityTimer = null;

  return {
    dir, files,
    settings: () => settings,
    setSettings(patch) {
      settings = { ...settings, ...patch };
      writeJson(files.settings, settings);
      return settings;
    },
    loadTokens() {
      if (!existsSync(files.session)) return null;
      try {
        const raw = readFileSync(files.session);
        return JSON.parse(crypto ? crypto.decrypt(raw) : raw.toString("utf8"));
      } catch { return null; }
    },
    saveTokens(pair) {
      const text = JSON.stringify(pair);
      writeFileSync(`${files.session}.tmp`, crypto ? crypto.encrypt(text) : text, { mode: 0o600 });
      renameSync(`${files.session}.tmp`, files.session);
    },
    clearTokens() { rmSync(files.session, { force: true }); },
    loadActivity: () => readJson(files.activity, []),
    saveActivity(list) {
      clearTimeout(activityTimer);
      activityTimer = setTimeout(() => { try { writeJson(files.activity, list); } catch {} }, 1_000);
    },
    log(what, extra = {}) {
      try {
        if (existsSync(files.log) && statSync(files.log).size > LOG_MAX) renameSync(files.log, `${files.log}.1`);
        appendFileSync(files.log, `${JSON.stringify({ at: new Date().toISOString(), what, ...extra })}\n`);
      } catch {}
    },
  };
}
