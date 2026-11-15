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

// A request made in the last 30 seconds (the click that opened this panel) starts a scan.
chrome.storage.session.get("viaRequest").then(({ viaRequest }) => {
  const fresh = viaRequest && Date.now() - viaRequest.at < 30_000 ? viaRequest : null;
  void load(fresh);
});

// Clicking the Gmail button again while the panel is open starts a new scan.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.viaRequest?.newValue) void load(changes.viaRequest.newValue);
});

document.getElementById("retry").addEventListener("click", () => {
  frame.src = "about:blank";
  void load(null);
});
