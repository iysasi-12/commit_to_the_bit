// Adds a floating "Summarize" button to Gmail. Clicking it opens the side panel, which walks
// through the choices (one at a time or all at once, length, voice) before anything is read.
// It doesn't read the Gmail page; the app reads your inbox through the Gmail API.
(() => {
  if (document.getElementById("via-summary-button")) return;

  const button = document.createElement("button");
  button.id = "via-summary-button";
  button.type = "button";
  button.textContent = "🎧 Summarize";
  button.title = "Summarize your inbox with Voice Inbox Assistant";
  button.setAttribute("aria-haspopup", "dialog");

  // The side panel must be opened during the click itself, so the message goes out right away.
  button.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "open-panel", setup: true });
  });

  document.body.appendChild(button);
})();
