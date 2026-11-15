// Loads the app in the side panel. When the Gmail button sends a length, (re)load the app with
// ?length=…&autostart=1 so it starts summarizing right away.

// ---- Where the side panel finds the app ----------------------------------------------------
// The live site, with this computer as the backup (start it with `npm.cmd run dev`).
// The Options page picks the mode (right-click the extension icon → Options):
//   "auto"  (default) the live site when THIS app is running there and healthy, otherwise this
//           computer. A different app on the domain doesn't count.
//   "live"  only the live site.
//   "local" only this computer.
// LOCALHOST ONLY: comment out the three LIVE lines and set DEFAULT_MODE to "local".
const LIVE_URL = "https://vocamail.biz/"; // LIVE
const LOCAL_URL = "http://localhost:3000/";
const TRY_ORDER = {
  auto: [LIVE_URL, LOCAL_URL], // LIVE
  live: [LIVE_URL], // LIVE
  local: [LOCAL_URL],
};
const DEFAULT_MODE = "auto";
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

const PAUSES = ["slow", "medium", "fast"];
const DEFAULT_PAUSE = "medium";
let myTabId = null;

async function savedPause() {
  const { viaPause } = await chrome.storage.sync.get("viaPause");
  return PAUSES.includes(viaPause) ? viaPause : DEFAULT_PAUSE;
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
  // The pause between emails is one setting shared by the extension and the app.
  const pause = await savedPause();
  if (request && request.at > lastRequestAt) {
    lastRequestAt = request.at;
    const what = request.setup ? "setup=1" : `length=${encodeURIComponent(request.length ?? "medium")}&autostart=1`;
    frame.src = `${appUrl}?${what}&pause=${pause}&t=${request.at}`;
  } else if (changed || !frame.src || frame.src === "about:blank") {
    frame.src = `${appUrl}?pause=${pause}`;
  }
  frame.dataset.server = appUrl === LOCAL_URL ? "local" : "live";
}

// Each Gmail button click is used exactly once, by the panel of the tab it came from, so
// reopening the panel, refreshing Gmail or another Gmail tab never starts anything by itself.
async function takeRequest() {
  const { viaRequest } = await chrome.storage.session.get("viaRequest");
  if (!viaRequest) return null;
  if (viaRequest.tabId !== undefined && myTabId !== null && viaRequest.tabId !== myTabId) return null;
  await chrome.storage.session.remove("viaRequest");
  return Date.now() - viaRequest.at < 10_000 ? viaRequest : null;
}

void chrome.tabs
  .query({ active: true, currentWindow: true })
  .then(([tab]) => {
    myTabId = tab?.id ?? null;
  })
  .catch(() => {})
  .then(takeRequest)
  .then((request) => load(request));

chrome.storage.onChanged.addListener((changes, area) => {
  // Clicking the Gmail button again while the panel is open shows the setup again.
  if (area === "session" && changes.viaRequest?.newValue) void takeRequest().then((request) => request && load(request));
  // Switching server on the Options page reloads the panel.
  if (area === "sync" && changes.viaServer) {
    appUrl = null;
    frame.src = "about:blank";
    void load(null);
  }
  // Pause level changed on the Options page: tell the open app.
  if (area === "sync" && changes.viaPause && appUrl) {
    frame.contentWindow?.postMessage({ type: "via-settings", pause: changes.viaPause.newValue }, new URL(appUrl).origin);
  }
});

// Leaving this Gmail tab: pause playback and cancel any pending "next email" right away. If the
// tab you switched to isn't Gmail, close the panel (it never stays open over other sites). The
// app keeps the queue, so reopening the panel on Gmail picks up where you left off.
function pauseApp() {
  if (appUrl) frame.contentWindow?.postMessage({ type: "via-pause-playback" }, new URL(appUrl).origin);
}
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (myTabId === null || tabId === myTabId) return;
  const mine = await chrome.tabs.get(myTabId).catch(() => null);
  if (mine && mine.windowId !== windowId) return; // another window: this panel's tab is still showing
  pauseApp();
  const now = await chrome.tabs.get(tabId).catch(() => null);
  const isGmail = (() => {
    try {
      return new URL(now?.url ?? "").origin === "https://mail.google.com";
    } catch {
      return false;
    }
  })();
  if (!isGmail) setTimeout(() => window.close(), 150); // give the pause message a moment to arrive
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== myTabId || info.url === undefined) return;
  try {
    if (new URL(info.url).origin !== "https://mail.google.com") pauseApp();
  } catch {
    pauseApp();
  }
});

// Pause level changed inside the app: save it for the extension too.
window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow || !appUrl || e.origin !== new URL(appUrl).origin) return;
  if (e.data?.type === "via-pause-changed" && PAUSES.includes(e.data.pause)) void chrome.storage.sync.set({ viaPause: e.data.pause });
});

document.getElementById("retry").addEventListener("click", () => {
  appUrl = null;
  frame.src = "about:blank";
  void load(null);
});
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
