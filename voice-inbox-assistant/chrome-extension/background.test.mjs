// Gmail-only side panel rules in background.js, run against a fake `chrome` API (no browser).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("./background.js", import.meta.url), "utf8");
const settle = () => new Promise((r) => setTimeout(r, 20));

function load(initialTabs) {
  const tabs = initialTabs.map((t) => ({ ...t }));
  const options = new Map();
  const titles = new Map();
  const opened = [];
  const listeners = { installed: [], startup: [], updated: [], replaced: [], message: [] };
  let session = null;
  let behavior = null;
  const on = (name) => ({ addListener: (f) => listeners[name].push(f) });
  const chrome = {
    sidePanel: {
      setOptions: async (o) => {
        const key = o.tabId ?? "global";
        options.set(key, { ...(options.get(key) ?? {}), ...o });
      },
      setPanelBehavior: async (b) => {
        behavior = b;
      },
      open: async ({ tabId }) => {
        opened.push(tabId);
      },
    },
    action: { setTitle: async ({ tabId, title }) => titles.set(tabId, title) },
    tabs: { query: async () => tabs, get: async (id) => tabs.find((t) => t.id === id), onUpdated: on("updated"), onReplaced: on("replaced") },
    runtime: { onInstalled: on("installed"), onStartup: on("startup"), onMessage: on("message") },
    storage: { session: { set: async (v) => (session = v) } },
  };
  vm.runInNewContext(SOURCE, { chrome, URL, console });
  return {
    tabs,
    options,
    titles,
    opened,
    get session() {
      return session;
    },
    get behavior() {
      return behavior;
    },
    navigate(id, url) {
      const tab = tabs.find((t) => t.id === id);
      tab.url = url;
      for (const f of listeners.updated) f(id, { url, status: "loading" }, tab);
    },
    message(msg, senderTab) {
      for (const f of listeners.message) f(msg, { tab: senderTab });
    },
    startup() {
      for (const f of listeners.startup) f();
    },
  };
}

const GMAIL = "https://mail.google.com/mail/u/0/#inbox";

test("on start: no global panel; only Gmail tabs get one", async () => {
  const ext = load([
    { id: 1, url: GMAIL },
    { id: 2, url: "https://news.example.com/" },
    { id: 3, url: "https://mail.google.com/mail/u/1/#inbox" },
    { id: 4, url: undefined }, // a tab whose URL the extension can't see (not Gmail)
  ]);
  await settle();
  assert.equal(ext.options.get("global")?.enabled, false, "global panel disabled");
  assert.deepEqual(ext.options.get(1), { tabId: 1, path: "panel.html", enabled: true });
  assert.deepEqual(ext.options.get(3), { tabId: 3, path: "panel.html", enabled: true }, "every Gmail tab, including a second account");
  assert.equal(ext.options.get(2)?.enabled, false);
  assert.equal(ext.options.get(4)?.enabled, false);
  assert.equal(ext.behavior.openPanelOnActionClick, true);
});

test("navigating a Gmail tab away closes its panel; coming back enables it again", async () => {
  const ext = load([{ id: 1, url: GMAIL }]);
  await settle();
  ext.navigate(1, "https://www.youtube.com/");
  await settle();
  assert.equal(ext.options.get(1).enabled, false);
  ext.navigate(1, GMAIL);
  await settle();
  assert.equal(ext.options.get(1).enabled, true);
  assert.equal(ext.options.get(1).path, "panel.html");
});

test("look-alike addresses are not Gmail", async () => {
  const ext = load([
    { id: 1, url: "https://mail.google.com.evil.example/" },
    { id: 2, url: "http://mail.google.com/" },
    { id: 3, url: "https://notmail.google.com/" },
    { id: 4, url: "https://accounts.google.com/signin" },
  ]);
  await settle();
  for (const id of [1, 2, 3, 4]) assert.equal(ext.options.get(id).enabled, false, `tab ${id}`);
});

test("the Summarize button opens that Gmail tab's panel and asks for the guided setup", async () => {
  const ext = load([{ id: 7, url: GMAIL }]);
  await settle();
  ext.message({ type: "open-panel", setup: true }, { id: 7, url: GMAIL });
  await settle();
  assert.deepEqual(ext.opened, [7]);
  assert.equal(ext.session.viaRequest.setup, true);
  assert.equal(ext.session.viaRequest.tabId, 7, "only that tab's panel takes the request");
});

test("messages from non-Gmail pages are ignored", async () => {
  const ext = load([{ id: 9, url: "https://example.com/" }]);
  await settle();
  ext.message({ type: "open-panel", setup: true }, { id: 9, url: "https://example.com/" });
  ext.message({ type: "something-else" }, { id: 9, url: GMAIL });
  await settle();
  assert.deepEqual(ext.opened, []);
  assert.equal(ext.session, null);
});

test("after a browser restart the rules are applied to every restored tab", async () => {
  const ext = load([]);
  await settle();
  ext.tabs.push({ id: 11, url: GMAIL }, { id: 12, url: "https://example.org/" });
  ext.startup();
  await settle();
  assert.equal(ext.options.get(11).enabled, true);
  assert.equal(ext.options.get(12).enabled, false);
  assert.equal(ext.options.get("global").enabled, false);
});
