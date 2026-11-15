// Adds a floating "AI Summary" button to Gmail. Clicking it asks for a summary length,
// then opens the side panel and starts summarizing. It doesn't read the Gmail page;
// the app reads your inbox through the Gmail API.
(() => {
  if (document.getElementById("via-summary-button")) return;

  const button = document.createElement("button");
  button.id = "via-summary-button";
  button.type = "button";
  button.textContent = "🎧 AI Summary";
  button.title = "Summarize your inbox with Voice Inbox Assistant";
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");

  const menu = document.createElement("div");
  menu.id = "via-length-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Choose summary length");
  menu.hidden = true;
  menu.innerHTML = `
    <div class="via-title">How long should the summaries be?</div>
    <button type="button" data-length="short"><b>Short</b><span>One sentence per email</span></button>
    <button type="button" data-length="medium"><b>Medium</b><span>2 to 3 sentences</span></button>
    <button type="button" data-length="long"><b>Long</b><span>Every detail, 4 to 6 sentences</span></button>
  `;

  function closeMenu() {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  button.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    button.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector("button")?.focus();
  });

  menu.addEventListener("click", (event) => {
    const choice = event.target.closest("button[data-length]");
    if (!choice) return;
    closeMenu();
    chrome.runtime.sendMessage({ type: "open-panel", length: choice.dataset.length });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) closeMenu();
  });

  document.body.appendChild(menu);
  document.body.appendChild(button);
})();
