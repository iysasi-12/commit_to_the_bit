// Loads the app in the side panel. When the Gmail button sends a length, (re)load the app with
// ?length=…&autostart=1 so it starts summarizing right away.
const APP_URL = "http://localhost:3000/";
const frame = document.getElementById("app");
const offline = document.getElementById("offline");
let lastRequestAt = 0;

async function reachable() {
  try {
    await fetch(APP_URL, { method: "HEAD", cache: "no-store" });
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
    frame.src = `${APP_URL}?length=${encodeURIComponent(request.length)}&autostart=1&t=${request.at}`;
  } else if (!frame.src || frame.src === "about:blank") {
    frame.src = APP_URL;
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

void takeRequest().then((request) => load(request));

// Picking a length again while the panel is open starts a new scan.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.viaRequest?.newValue) void takeRequest().then((request) => request && load(request));
});

document.getElementById("retry").addEventListener("click", () => {
  frame.src = "about:blank";
  void load(null);
});
