// Saves which server the side panel loads. The panel reloads itself when this changes.
const form = document.getElementById("form");
const saved = document.getElementById("saved");
// LOCALHOST ONLY: reduce to ["local"], set DEFAULT_MODE to "local" (see panel.js).
const MODES = ["auto", "live", "local"];
const DEFAULT_MODE = "auto";
const MESSAGES = {
  auto: "Saved. The side panel uses vocamail.biz, or this computer if vocamail.biz isn't working.",
  live: "Saved. The side panel uses vocamail.biz only.",
  local: "Saved. The side panel uses this computer only.",
};

void chrome.storage.sync.get("viaServer").then(({ viaServer }) => {
  const value = MODES.includes(viaServer) ? viaServer : DEFAULT_MODE;
  form.querySelector(`input[value="${value}"]`).checked = true;
});

form.addEventListener("change", async (e) => {
  const value = MODES.includes(e.target.value) ? e.target.value : DEFAULT_MODE;
  await chrome.storage.sync.set({ viaServer: value });
  saved.textContent = MESSAGES[value];
});

// Pause between emails: shared with the app (an open side panel picks it up right away).
const PAUSES = { slow: "1.4 seconds", medium: "0.7 seconds", fast: "0.35 seconds" };
const DEFAULT_PAUSE = "medium";
const pauseForm = document.getElementById("pause-form");
const pauseSaved = document.getElementById("pause-saved");

void chrome.storage.sync.get("viaPause").then(({ viaPause }) => {
  const value = viaPause in PAUSES ? viaPause : DEFAULT_PAUSE;
  pauseForm.querySelector(`input[value="${value}"]`).checked = true;
});

pauseForm.addEventListener("change", async (e) => {
  const value = e.target.value in PAUSES ? e.target.value : DEFAULT_PAUSE;
  await chrome.storage.sync.set({ viaPause: value });
  pauseSaved.textContent = `Saved. ${value[0].toUpperCase()}${value.slice(1)}: ${PAUSES[value]} between emails.`;
});
