// The window. Everything it shows comes from the main process's state messages.
const $ = (id) => document.getElementById(id);
const api = window.autostart;
let state = null;
let showingSettings = false;

const time = (at) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (at) => {
  const d = new Date(at), today = new Date();
  if (d.toDateString() === today.toDateString()) return time(at);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};

function describe(baby) {
  if (baby.problem) return ["Can't reach the camera", "Retrying on its own. Start monitoring in the Nanit app until it's back."];
  switch (baby.phase) {
    case "monitoring":
      return ["Monitoring breathing", [baby.bpm ? `${baby.bpm} breaths/min` : null, baby.startedAt ? `since ${time(baby.startedAt)}` : null].filter(Boolean).join(" · ") || "Nanit is watching breathing"];
    case "searching":
      return baby.breathing === "BABY_NOT_IN_BED"
        ? ["Monitoring, baby out of bed", "Stopping monitoring for you."]
        : ["Monitoring, looking for Breathing Wear", "Nanit can't see the band. If it stays hidden for 8 minutes, monitoring stops."];
    case "watching":
      if (baby.backoffUntil) return ["Ready", `Waiting until ${time(baby.backoffUntil)} after a short session.`];
      if (baby.held) return ["Ready", "You stopped monitoring in Nanit, so autostart waits until your baby is picked up."];
      return ["Ready", "Monitoring starts when your baby is in view wearing Breathing Wear."];
    case "off":
      return ["Autostart is off", "Turn it on to start monitoring automatically."];
    default:
      return ["Connecting to the camera", "This takes a few seconds."];
  }
}

function renderBabies() {
  const list = $("babies");
  const template = $("baby-card");
  list.replaceChildren(...state.babies.map((baby) => {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.uid = baby.uid;
    card.classList.add(`phase-${baby.problem ? "problem" : baby.phase}`);
    card.querySelector(".name").textContent = baby.name;
    const toggle = card.querySelector(".enabled");
    toggle.checked = baby.enabled !== false;
    toggle.setAttribute("aria-label", `Autostart for ${baby.name}`);
    toggle.addEventListener("change", () => api.setEnabled(baby.uid, toggle.checked));
    const [headline, detail] = describe(baby);
    card.querySelector(".headline").textContent = headline;
    card.querySelector(".detail").textContent = detail;
    return card;
  }));
}

function renderActivity() {
  const items = state.activity.slice(0, 12);
  const many = state.babies.length > 1;
  $("activity").replaceChildren(...(items.length ? items.map((entry) => {
    const li = document.createElement("li");
    const when = document.createElement("time");
    when.textContent = day(entry.at);
    const text = document.createElement("span");
    text.textContent = many ? `${entry.baby}: ${entry.text}` : entry.text;
    li.append(when, text);
    return li;
  }) : [Object.assign(document.createElement("li"), { className: "empty", textContent: "Nothing yet. Starts and stops show up here." })]));
}

function show(view) {
  for (const id of ["view-sign-in", "view-code", "view-home", "view-settings"]) $(id).hidden = id !== view;
}

function render() {
  document.documentElement.className = `platform-${state.platform}`;
  const signedIn = state.account === "signed-in";
  $("open-settings").hidden = !signedIn;
  $("open-settings").textContent = showingSettings ? "Done" : "Settings";
  if (!signedIn) showingSettings = false;

  if (state.account === "signed-out") {
    show("view-sign-in");
    $("sign-in-error").hidden = !state.error;
    $("sign-in-error").textContent = state.error ?? "";
    $("sign-in-button").disabled = false;
    $("sign-in-button").textContent = "Sign in with Nanit";
    return;
  }
  if (state.account === "needs-code") {
    show("view-code");
    $("code-error").hidden = !state.error;
    $("code-error").textContent = state.error ?? "";
    $("code-button").disabled = false;
    $("code-button").textContent = "Continue";
    if (state.error) $("code").select();
    else if (document.activeElement !== $("code")) $("code").focus();
    return;
  }
  if (showingSettings) {
    show("view-settings");
    for (const box of document.querySelectorAll("[data-setting]")) box.checked = Boolean(state.settings[box.dataset.setting]);
    $("account-email").textContent = state.user?.email ? `Signed in as ${state.user.email}` : "Signed in";
    $("version").textContent = state.version;
    return;
  }
  show("view-home");
  $("setup").hidden = !state.setup;
  $("setup").textContent = state.setup ?? "";
  $("update-banner").hidden = !state.update;
  if (state.update) $("update-text").textContent = `Version ${state.update.version} is ready.`;
  renderBabies();
  renderActivity();
}

$("sign-in-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("sign-in-button").disabled = true;
  $("sign-in-button").textContent = "Signing in...";
  $("sign-in-error").hidden = true;
  api.signIn($("email").value, $("password").value).finally(() => { $("password").value = ""; });
});
$("code-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("code-button").disabled = true;
  $("code-button").textContent = "Checking...";
  $("code-error").hidden = true;
  api.code($("code").value).finally(() => { $("code").value = ""; });
});
$("code-back").addEventListener("click", () => api.cancelSignIn());
$("open-settings").addEventListener("click", () => { showingSettings = !showingSettings; render(); });
$("sign-out").addEventListener("click", () => { showingSettings = false; api.signOut(); });
$("update-button").addEventListener("click", () => api.installUpdate());
$("check-updates").addEventListener("click", async () => {
  $("update-status").textContent = "Checking...";
  const result = await api.checkUpdates();
  $("update-status").textContent = {
    current: "You have the latest version.",
    downloading: `Downloading ${result.version}. You'll be asked to restart.`,
    failed: "Couldn't check right now. It tries again on its own.",
    dev: "Updates are off in this build.",
  }[result.status];
});
for (const box of document.querySelectorAll("[data-setting]")) box.addEventListener("change", () => api.setSetting(box.dataset.setting, box.checked));
for (const button of document.querySelectorAll("[data-open]")) button.addEventListener("click", () => api.open(button.dataset.open));

api.onState((next) => { state = next; render(); });
// Relative times ("since 10:42 PM") and back-off waits stay current.
setInterval(() => { if (state) render(); }, 30_000);
