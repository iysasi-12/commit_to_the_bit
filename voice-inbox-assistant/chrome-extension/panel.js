// Loads the app in the side panel. When the Gmail button sends a length, (re)load the app with
// ?length=…&autostart=1 so it starts summarizing right away.

// ---- Where the side panel finds the app ----------------------------------------------------
// The live site, and this computer as the backup (start it with `npm.cmd run dev`).
// The Options page picks one of three modes (right-click the extension icon → Options):
//   "auto"  (default) tries the live site first, and uses this computer if the live site
//           doesn't answer within a few seconds — the presentation backup, no editing needed.
//   "live"  only the live site.
//   "local" only this computer.
const LIVE_URL = "https://vocamail.biz/";
const LOCAL_URL = "http://localhost:3000/";
const TRY_ORDER = {
  auto: [LIVE_URL, LOCAL_URL],
  live: [LIVE_URL],
  local: [LOCAL_URL],
};
const TIMEOUT_MS = 4000;
// ---------------------------------------------------------------------------------------------

const frame = document.getElementById("app");
const offline = document.getElementById("offline");
const tried = document.getElementById("tried");
const startHint = document.getElementById("start-hint");
let lastRequestAt = 0;
let appUrl = null;

async function reachable(url) {
  try {
    // no-cors: we only need to know the server answers, not read the page.
    await fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

/** The first server in the chosen mode that answers, or null. */
async function pickServer() {
  const { viaServer } = await chrome.storage.sync.get("viaServer");
  const order = TRY_ORDER[viaServer] ?? TRY_ORDER.auto;
  for (const url of order) {
    if (await reachable(url)) return { url, order };
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
