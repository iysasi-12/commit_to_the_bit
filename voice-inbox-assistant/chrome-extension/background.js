// Clicking the toolbar icon opens the side panel too.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// The Gmail button asks us to open the side panel for its tab.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "open-panel" && sender.tab?.id !== undefined) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch((err) => console.warn("Couldn't open side panel:", err));
  }
});
