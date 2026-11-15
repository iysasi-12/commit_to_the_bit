// Loads the app in the side panel. When the Gmail button sends a length, (re)load the app with
// ?length=…&autostart=1 so it starts summarizing right away.
// Which server to use is chosen on the extension's Options page (default: this computer).
const SERVERS = { local: "http://localhost:3000/", live: "https://vocamain.biz/" };
const frame = document.getElementById("app");
const offline = document.getElementById("offline");
const where = document.getElementById("where");
const startHint = document.getElementById("start-hint");
let lastRequestAt = 0;
let appUrl = SERVERS.local;

async function chooseServer() {
  const { viaServer } = await chrome.storage.sync.get("viaServer");
  appUrl = SERVERS[viaServer] ?? SERVERS.local;
  where.textContent = appUrl;
  startHint.hidden = appUrl !== SERVERS.local;
}

async function reachable() {
  try {
    await fetch(appUrl, { method: "HEAD", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

async function load(request) {
  if (!(await reachable())) {
    frame.hidden = true;
    offline.hidden = false;
    return;
  }
  offline.hidden = true;
  frame.hidden = false;
  if (request && request.at > lastRequestAt) {
    lastRequestAt = request.at;
    frame.src = `${appUrl}?length=${encodeURIComponent(request.length)}&autostart=1&t=${request.at}`;
  } else if (!frame.src || frame.src === "about:blank" || !frame.src.startsWith(appUrl)) {
    frame.src = appUrl;
  }
}

// Each length pick in Gmail is used exactly once, then removed, so reopening the panel,
// refreshing Gmail or using the toolbar icon never starts a scan by itself.
async function takeRequest() {
  const { viaRequest } = await chrome.storage.session.get("viaRequest");
  if (!viaRequest) return null;
  await chrome.storage.session.remove("viaRequest");
  return Date.now() - viaRequest.at < 10_000 ? viaRequest : null;
}

void chooseServer()
  .then(takeRequest)
  .then((request) => load(request));

chrome.storage.onChanged.addListener((changes, area) => {
  // Picking a length again while the panel is open starts a new scan.
  if (area === "session" && changes.viaRequest?.newValue) void takeRequest().then((request) => request && load(request));
  // Switching server on the Options page reloads the panel there.
  if (area === "sync" && changes.viaServer) {
    frame.src = "about:blank";
    void chooseServer().then(() => load(null));
  }
});

document.getElementById("retry").addEventListener("click", () => {
  frame.src = "about:blank";
  void load(null);
});
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
