// Saves which server the side panel loads. The panel reloads itself when this changes.
const form = document.getElementById("form");
const saved = document.getElementById("saved");
const MODES = ["auto", "live", "local"];
const MESSAGES = {
  auto: "Saved. The side panel uses vocamail.biz, or this computer if vocamail.biz doesn't answer.",
  live: "Saved. The side panel uses vocamail.biz only.",
  local: "Saved. The side panel uses this computer only.",
};

void chrome.storage.sync.get("viaServer").then(({ viaServer }) => {
  const value = MODES.includes(viaServer) ? viaServer : "auto";
  form.querySelector(`input[value="${value}"]`).checked = true;
});

form.addEventListener("change", async (e) => {
  const value = MODES.includes(e.target.value) ? e.target.value : "auto";
  await chrome.storage.sync.set({ viaServer: value });
  saved.textContent = MESSAGES[value];
});
