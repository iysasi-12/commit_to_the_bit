// Shows a "start the app" message instead of a blank panel when localhost:3000 isn't running.
const APP_URL = "http://localhost:3000/";
const frame = document.getElementById("app");
const offline = document.getElementById("offline");

async function check() {
  try {
    await fetch(APP_URL, { method: "HEAD", cache: "no-store" });
    offline.hidden = true;
    frame.hidden = false;
    if (frame.src !== APP_URL) frame.src = APP_URL;
  } catch {
    frame.hidden = true;
    offline.hidden = false;
  }
}

document.getElementById("retry").addEventListener("click", () => {
  frame.src = "about:blank";
  void check().then(() => {
    frame.src = APP_URL;
  });
});

void check();
