// The only bridge between the window and the app: state in, a few named actions out.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("autostart", {
  onState: (callback) => ipcRenderer.on("state", (_event, state) => callback(state)),
  signIn: (email, password) => ipcRenderer.invoke("sign-in", { email, password }),
  code: (code) => ipcRenderer.invoke("code", code),
  resendCode: () => ipcRenderer.invoke("resend-code"),
  cancelSignIn: () => ipcRenderer.invoke("cancel-sign-in"),
  signOut: () => ipcRenderer.invoke("sign-out"),
  setEnabled: (uid, on) => ipcRenderer.invoke("set-enabled", { uid, on }),
  setSetting: (key, value) => ipcRenderer.invoke("set-setting", { key, value }),
  open: (what) => ipcRenderer.invoke("open", what),
  checkUpdates: () => ipcRenderer.invoke("check-updates"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
});
