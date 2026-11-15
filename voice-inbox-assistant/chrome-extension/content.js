// Adds a floating "AI Summary" button to Gmail. It only opens the side panel;
// it doesn't read the page. Your inbox is read by the app through the Gmail API.
(() => {
  if (document.getElementById("via-summary-button")) return;
  const button = document.createElement("button");
  button.id = "via-summary-button";
  button.type = "button";
  button.textContent = "🎧 AI Summary";
  button.title = "Open Voice Inbox Assistant in the side panel";
  button.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "open-panel" });
  });
  document.body.appendChild(button);
})();
