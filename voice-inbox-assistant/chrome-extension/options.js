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
