// Loads the app in the side panel. When the Gmail button sends a length, (re)load the app with
// ?length=…&autostart=1 so it starts summarizing right away.

// ---- Where the side panel finds the app ----------------------------------------------------
// FOR NOW: this computer only (start the app with `npm.cmd run dev`).
//
// TO USE THE LIVE SITE LATER: uncomment the three lines marked LIVE below, switch DEFAULT_MODE
// to "auto", and uncomment the two matching choices in options.html and options.js.
//   "auto"  tries the live site first, and uses this computer if the live site isn't healthy.
//   "live"  only the live site.
//   "local" only this computer.
// const LIVE_URL = "https://vocamail.biz/"; // LIVE
const LOCAL_URL = "http://localhost:3000/";
const TRY_ORDER = {
  // auto: [LIVE_URL, LOCAL_URL], // LIVE
  // live: [LIVE_URL], // LIVE
  local: [LOCAL_URL],
};
const DEFAULT_MODE = "local"; // later: "auto"
const TIMEOUT_MS = 4000;
// ---------------------------------------------------------------------------------------------

const frame = document.getElementById("app");
const offline = document.getElementById("offline");
const tried = document.getElementById("tried");
const startHint = document.getElementById("start-hint");
let lastRequestAt = 0;
let appUrl = null;

/**
 * True only when THIS app is there and working: /api/health must answer
 * {"ok": true, "app": "voice-inbox-assistant"}. A server that is up but shows an error page, or a
 * different app on the same domain (which may also refuse to be shown in a panel), counts as
 * down, so Automatic mode moves on to this computer.
 */
async function healthy(url) {
  try {
    const res = await fetch(`${url}api/health`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true && body?.app === "voice-inbox-assistant";
  } catch {
    return false;
  }
}

/** The first server in the chosen mode whose app is healthy, or null. */
async function pickServer() {
  const { viaServer } = await chrome.storage.sync.get("viaServer");
  // A mode saved earlier ("auto"/"live") that's commented out above falls back to the default.
  const order = TRY_ORDER[viaServer] ?? TRY_ORDER[DEFAULT_MODE];
  for (const url of order) {
    if (await healthy(url)) return { url, order };
  }
  return { url: null, order };
}

async function load(request) {
  const { url, order } = await pickServer();
  if (!url) {
    frame.hidden = true;
    offline.hidden = false;
    tried.textContent = order.join(" and ");
    startHint.hidden = !order.includes(LOCAL_URL);
    return;
  }
  offline.hidden = true;
  frame.hidden = false;
  const changed = url !== appUrl;
  appUrl = url;
  if (request && request.at > lastRequestAt) {
    lastRequestAt = request.at;
    frame.src = `${appUrl}?length=${encodeURIComponent(request.length)}&autostart=1&t=${request.at}`;
  } else if (changed || !frame.src || frame.src === "about:blank") {
    frame.src = appUrl;
  }
  frame.dataset.server = appUrl === LOCAL_URL ? "local" : "live";
}

// Each length pick in Gmail is used exactly once, then removed, so reopening the panel,
// refreshing Gmail or using the toolbar icon never starts a scan by itself.
async function takeRequest() {
  const { viaRequest } = await chrome.storage.session.get("viaRequest");
  if (!viaRequest) return null;
  await chrome.storage.session.remove("viaRequest");
  return Date.now() - viaRequest.at < 10_000 ? viaRequest : null;
}

void takeRequest().then((request) => load(request));

chrome.storage.onChanged.addListener((changes, area) => {
  // Picking a length again while the panel is open starts a new scan.
  if (area === "session" && changes.viaRequest?.newValue) void takeRequest().then((request) => request && load(request));
  // Switching mode on the Options page reloads the panel.
  if (area === "sync" && changes.viaServer) {
    appUrl = null;
    frame.src = "about:blank";
    void load(null);
  }
});

document.getElementById("retry").addEventListener("click", () => {
  appUrl = null;
  frame.src = "about:blank";
  void load(null);
});
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
