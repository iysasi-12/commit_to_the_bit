// The side panel exists only on Gmail tabs (https://mail.google.com/*), using Chrome's
// tab-specific side panels:
//   - it's disabled globally, so it can't stay open across unrelated websites;
//   - each Gmail tab gets its own panel; switching to another tab hides it;
//   - navigating a Gmail tab away from Gmail closes that tab's panel; closing the tab closes it.
// Ordinary clicks in Gmail or in the panel are untouched.

const GMAIL_ORIGIN = "https://mail.google.com";
const PANEL_PATH = "panel.html";

function isGmail(url) {
  try {
    return new URL(url).origin === GMAIL_ORIGIN;
  } catch {
    return false;
  }
}

async function applyToTab(tabId, url) {
  try {
    if (isGmail(url)) {
      await chrome.sidePanel.setOptions({ tabId, path: PANEL_PATH, enabled: true });
      await chrome.action.setTitle({ tabId, title: "Open Voice Inbox Assistant" });
    } else {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
      await chrome.action.setTitle({ tabId, title: "Voice Inbox Assistant works on Gmail (mail.google.com)" });
    }
  } catch {
    // The tab closed meanwhile; nothing to do.
  }
}

async function syncAllTabs() {
  // No global panel: it may only appear on Gmail tabs.
  await chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => (t.id === undefined ? null : applyToTab(t.id, t.url))));
}

chrome.runtime.onInstalled.addListener(() => void syncAllTabs());
chrome.runtime.onStartup.addListener(() => void syncAllTabs());
// The service worker can also wake up for other reasons; make sure the rules are in place.
void syncAllTabs();

// Navigating within a tab: enable on Gmail, close and disable anywhere else.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url !== undefined || info.status === "loading") void applyToTab(tabId, info.url ?? tab.url);
});
chrome.tabs.onReplaced?.addListener((tabId) => {
  void chrome.tabs.get(tabId).then((t) => applyToTab(tabId, t.url)).catch(() => {});
});

// The Gmail button: open this tab's panel right away (it must happen during the click), then
// tell the panel to show the guided setup.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "open-panel" || sender.tab?.id === undefined || !isGmail(sender.tab.url)) return;
  const tabId = sender.tab.id;
  chrome.sidePanel.setOptions({ tabId, path: PANEL_PATH, enabled: true }).catch(() => {});
  chrome.sidePanel.open({ tabId }).catch((err) => console.warn("Couldn't open side panel:", err));
  chrome.storage.session.set({ viaRequest: { setup: true, tabId, at: Date.now() } });
});
