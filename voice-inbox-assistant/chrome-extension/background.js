// Clicking the toolbar icon opens the side panel too (without auto-starting a scan).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// The Gmail button sends the chosen length. Open the panel right away (it must happen during
// the click), then hand the request to the panel, which starts the scan.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "open-panel" || sender.tab?.id === undefined) return;
  chrome.sidePanel.open({ tabId: sender.tab.id }).catch((err) => console.warn("Couldn't open side panel:", err));
  const length = ["short", "medium", "long"].includes(message.length) ? message.length : "medium";
  chrome.storage.session.set({ viaRequest: { length, at: Date.now() } });
});
