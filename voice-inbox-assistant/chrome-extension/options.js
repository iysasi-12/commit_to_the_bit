// Saves which server the side panel loads. The panel reloads itself when this changes.
const form = document.getElementById("form");
const saved = document.getElementById("saved");

void chrome.storage.sync.get("viaServer").then(({ viaServer }) => {
  const value = viaServer === "live" ? "live" : "local";
  form.querySelector(`input[value="${value}"]`).checked = true;
});

form.addEventListener("change", async (e) => {
  const value = e.target.value === "live" ? "live" : "local";
  await chrome.storage.sync.set({ viaServer: value });
  saved.textContent = value === "live" ? "Saved. The side panel now uses vocamain.biz." : "Saved. The side panel now uses this computer.";
});
