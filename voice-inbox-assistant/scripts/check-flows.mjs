// Browser flows in headless Chrome (MOCK inbox/audio/Gmail actions in the page; real app code).
//   npm run check:flows -- http://localhost:3000
// Covers: guided setup (with Back, readable voice names), One at a time waiting for the person,
// Delete / Next / Reorganize, the three pause levels (measured), no stale timers or double
// playback, resume after a reload, and the pause setting shared with the extension panel.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { encode } from "next-auth/jwt";

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
const isLocal = ["localhost", "127.0.0.1"].includes(new URL(BASE).hostname);
const env = (file) => {
  const p = new URL(`../${file}`, import.meta.url);
  return existsSync(p) ? Object.fromEntries(readFileSync(p, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])) : {};
};
const secret = process.env.CHECK_AUTH_SECRET || (isLocal ? env(".env.local") : env(".env.live")).AUTH_SECRET;
const SESSION = await encode({
  secret,
  salt: "authjs.session-token",
  maxAge: 3600,
  token: { name: "Flow Test", email: "flow.test@example.com", sub: "flow", access_token: "placeholder", expires_at: Math.floor(Date.now() / 1000) + 3600, can_modify: true },
});
const CHROME = process.env.CHROME ?? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((p) => existsSync(p));

const MOCK = String.raw`(() => {
  const LONG = "Supercalifragilisticexpialidocious-Narrator-With-An-Extremely-Long-Name";
  const voices = { custom: [], presets: [
    { voice_id: "v1aaaaa", name: "Bella - Professional, Bright, Warm", description: "Bright and warm.", preview_url: null },
    { voice_id: "v2bbbbb", name: LONG, description: "A very long name, to test the layout.", preview_url: null },
    { voice_id: "v3ccccc", name: "Roger - Laid-Back, Casual, Resonant", description: "Casual.", preview_url: null },
  ], slots: null, mine: { used: 0, limit: 3 } };
  const B = (group, id, body, extra = {}) => ({ id, from: "Sender " + id + " <" + id + "@example.com>", subject: "Subject " + id, category: group === "school" ? "work" : group === "spam" || group === "skipped" ? "transactions" : group, group, body, summary: body, ...extra });
  const queue = [
    B("work", "w1", "Priya moved sprint planning to Thursday."),
    B("work", "w2", "Marcus needs the client deck by Friday."),
    B("work", "w3", "Benefits enrollment closes November 30th."),
    B("personal", "p1", "Jordan asked about ramen on Friday."),
    B("spam", "x1", "Possible spam from Lottery Board: \"You have won\". I didn't read it.", { note: "possible-spam", reasons: ["prize or lottery claim"] }),
    B("skipped", "sensitive-notice", "One more thing. I skipped one sensitive email: one banking or financial email."),
  ];
  function wav(sec) { const rate = 8000, n = Math.floor(rate * sec), b = new ArrayBuffer(44 + n), v = new DataView(b); const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0))); s(0, "RIFF"); v.setUint32(4, 36 + n, true); s(8, "WAVE"); s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, "data"); v.setUint32(40, n, true); for (let i = 0; i < n; i++) v.setUint8(44 + i, 128); return new Blob([b], { type: "audio/wav" }); }
  // Like real ElevenLabs: audio takes a while to make (measured 1.3-2.3 s); clips last a few seconds.
  window.__cfg = { ttsDelayMs: 1200, clipSec: 2.0 };
  window.__log = { tts: [], emails: [], actions: [], events: [] };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init && init.method) || "GET";
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/api/voices") && method === "GET") return reply(voices);
    if (url.includes("/api/labels")) return reply({ labels: [{ id: "Label_3", name: "Receipts" }, { id: "Label_9", name: "Work" }] });
    const action = url.match(/\/api\/emails\/([^/]+)\/(trash|move)/);
    if (action) { window.__log.actions.push({ id: decodeURIComponent(action[1]), kind: action[2], body: JSON.parse(init.body || "{}") }); return reply({ ok: true }); }
    if (url.includes("/api/emails")) { window.__log.emails.push(JSON.parse(init.body)); return reply({ queue, stats: { fetched: 6, hours: null, spam: 1, failed: 0, sensitive: 1, sensitiveByKind: { financial: 1 } } }); }
    if (url.includes("/api/tts")) {
      const body = JSON.parse(init.body);
      window.__log.tts.push({ text: body.text, voiceId: body.voiceId, at: performance.now() });
      await new Promise((r) => setTimeout(r, window.__cfg.ttsDelayMs));
      return new Response(wav(window.__cfg.clipSec), { status: 200, headers: { "Content-Type": "audio/wav" } });
    }
    return realFetch(input, init);
  };
  for (const type of ["playing", "ended", "pause"]) document.addEventListener(type, (e) => window.__log.events.push({ type, t: performance.now(), src: e.target.src }), true);
})();`;

const PORT = 9338;
const OUT = join(tmpdir(), "voice-inbox-flows");
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}`, "--no-first-run", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
process.on("exit", () => chrome.kill());
for (let i = 0; i < 40; i++) {
  try {
    await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    break;
  } catch {
    await sleep(250);
  }
}

async function openTab() {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 1;
  const pending = new Map();
  const sessions = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result ?? m.error);
      pending.delete(m.id);
    } else if (m.method === "Target.attachedToTarget") {
      sessions.push(m.params);
      void send("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((res) => {
      const i = id++;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const evaluate = async (expression, sessionId) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId))?.result?.value;
  await send("Page.enable");
  await send("Network.enable");
  await send("Network.setCookie", { name: "authjs.session-token", value: SESSION, url: `${BASE}/`, path: "/", httpOnly: true, ...(BASE.startsWith("https") ? { secure: true, sameSite: "None" } : {}) });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
  return { send, evaluate, sessions, close: () => fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`) };
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  console.log(results.at(-1));
};
const waitFor = async (tab, expr, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await tab.evaluate(expr)) return true;
    await sleep(100);
  }
  return false;
};
// Matches a button's visible text, ignoring leading markers like "○"/"●" (first match in page order).
const click = (tab, text) =>
  tab.evaluate(
    `(() => { const t = ${JSON.stringify(text)}; const b = [...document.querySelectorAll("button")].find((x) => !x.disabled && x.textContent.replace(/^[○●\\s]+/, "").trim().startsWith(t)); if (b) b.click(); return !!b; })()`,
  );
const log = (tab) => tab.evaluate("window.__log");
const statusText = (tab) => tab.evaluate(`document.querySelector("#player-h")?.closest("section")?.querySelector("[role=status]")?.textContent ?? ""`);
const heading = (tab) => tab.evaluate(`document.querySelector("#player-h")?.textContent ?? ""`);
const playingCount = async (tab) => (await log(tab)).events.filter((e) => e.type === "playing").length;

try {
  // ---------- 1. Guided setup (what the Gmail Summarize button opens) ----------
  {
    const tab = await openTab();
    await tab.evaluate(`localStorage.clear()`);
    await tab.send("Page.navigate", { url: `${BASE}/?setup=1` });
    check("Summarize opens the guided setup at step 1", await waitFor(tab, `document.querySelector("#setup-h")?.textContent === "How should I read them?"`));
    await click(tab, "One at a time");
    await click(tab, "Next →");
    check("step 2: summary length", await waitFor(tab, `document.querySelector("#setup-h")?.textContent === "How long should each summary be?"`));
    await click(tab, "Short");
    await click(tab, "← Back");
    const backKept = await waitFor(tab, `document.querySelector("#setup-h")?.textContent === "How should I read them?" && [...document.querySelectorAll("[aria-pressed=true]")].some((b) => b.textContent.includes("One at a time"))`);
    check("Back returns to the previous step and keeps the choice", backKept);
    await click(tab, "Next →");
    await click(tab, "Next →");
    check("step 3: voices load with full, readable names", await waitFor(tab, `[...document.querySelectorAll("[aria-label=Voices] li")].length === 3`));
    const longOk = await tab.evaluate(`(() => { const el = [...document.querySelectorAll("[aria-label=Voices] span[title]")].find((s) => s.textContent.startsWith("Supercali")); return el && el.textContent.length > 60 && el.scrollWidth <= el.clientWidth + 1; })()`);
    check("the long voice name is shown in full (not cut off)", longOk);
    await click(tab, "Supercali");
    await click(tab, "Next →");
    const confirm1 = await tab.evaluate(`document.querySelector("[role=dialog] dl")?.textContent ?? ""`);
    check("step 4 confirms every choice", confirm1.includes("One at a time") && confirm1.includes("Short") && confirm1.includes("Supercalifragilisticexpialidocious-Narrator-With-An-Extremely-Long-Name"), confirm1);
    await click(tab, "← Back");
    await click(tab, "Roger");
    await click(tab, "Next →");
    const confirm2 = await tab.evaluate(`document.querySelector("[role=dialog] dl")?.textContent ?? ""`);
    check("changing the voice after going back is reflected", confirm2.includes("Roger - Laid-Back, Casual, Resonant"), confirm2);
    await click(tab, "▶ Start summarizing");
    check("Start scans", await waitFor(tab, `window.__log.emails.length === 1`));
    const l1 = await log(tab);
    check("the chosen length is what the scan asks for", l1.emails[0]?.length === "short", JSON.stringify(l1.emails[0]));
    await waitFor(tab, `window.__log.tts.length >= 1`);
    check("the chosen voice is the one that speaks", (await log(tab)).tts[0]?.voiceId === "v3ccccc", (await log(tab)).tts[0]?.voiceId);
    check("the 'Reading with' label shows that voice", (await tab.evaluate(`document.querySelector("#voicebox-h")?.parentElement?.textContent ?? ""`)).includes("Roger - Laid-Back"));

    // ---------- 2. One at a time waits; Delete / Next / Reorganize ----------
    await waitFor(tab, `window.__log.events.some((e) => e.type === "ended")`, 20000);
    await sleep(3000);
    const l2 = await log(tab);
    check("One at a time: after an email, nothing else plays (waited 3 s)", l2.tts.length === 1 && (await playingCount(tab)) === 1, `${l2.tts.length} audio requests, ${await playingCount(tab)} started`);
    check("…and it says it's waiting", (await statusText(tab)).includes("I'll wait"), await statusText(tab));
    await click(tab, "Next →");
    await waitFor(tab, `window.__log.events.filter((e) => e.type === "playing").length === 2`, 10000);
    check("Next plays the next email without changing the first", (await heading(tab)).startsWith("Email 2 of") && (await log(tab)).actions.length === 0, await heading(tab));
    await click(tab, "🗑 Delete");
    await waitFor(tab, `window.__log.actions.length === 1`);
    const del = (await log(tab)).actions[0];
    check("Delete moves the current email to Trash", del?.id === "w2" && del?.kind === "trash", JSON.stringify(del));
    check("…then goes on to the next email", await waitFor(tab, `document.querySelector("#player-h")?.textContent.startsWith("Email 3 of")`));
    await waitFor(tab, `window.__log.events.filter((e) => e.type === "playing").length >= 3`, 10000);
    await click(tab, "📁 Reorganize");
    check("Reorganize lists your labels, best match first", await waitFor(tab, `[...document.querySelectorAll("[role=dialog][aria-label] li button")].map((b) => b.textContent).join("|").startsWith("WorkSuggested")`));
    await click(tab, "WorkSuggested");
    await waitFor(tab, `window.__log.actions.length === 2`);
    const mv = (await log(tab)).actions[1];
    check("Reorganize moves it to the chosen label", mv?.id === "w3" && mv?.kind === "move" && mv?.body?.labelId === "Label_9", JSON.stringify(mv));
    check("…then goes on", await waitFor(tab, `document.querySelector("#player-h")?.textContent.startsWith("Email 4 of")`));
    const spokenAll = (await log(tab)).tts.map((t) => t.text).join(" | ");
    check("possible spam is never read in the All list", !spokenAll.includes("Possible spam"), spokenAll.slice(0, 120));
    check("possible spam has its own tab", (await tab.evaluate(`[...document.querySelectorAll("[role=tab]")].map((t) => t.textContent).join("|")`)).includes("Possible spam (1)"));

    // ---------- 3. Resume after leaving and coming back ----------
    await tab.send("Page.navigate", { url: `${BASE}/` });
    check("reopening picks up where you left off", await waitFor(tab, `document.body.innerText.includes("Picked up where you left off")`));
    check("…at the same email", (await heading(tab)).startsWith("Email 4 of"), await heading(tab));
    await tab.evaluate(`[...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.startsWith("Work")).click()`);
    await sleep(300);
    await tab.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Next →")?.click()`);
    await sleep(300);
    check("…with Delete/Reorganize decisions remembered", (await tab.evaluate(`document.body.innerText.includes("Moved to Trash")`)) === true);
    await tab.close();
  }

  // ---------- 4. Pause between emails: measured for each level ----------
  for (const level of ["slow", "medium", "fast"]) {
    const expected = { slow: 1400, medium: 700, fast: 350 }[level];
    const tab = await openTab();
    await tab.evaluate(`localStorage.clear()`);
    await tab.send("Page.navigate", { url: `${BASE}/?pause=${level}` });
    await waitFor(tab, `!!document.querySelector("#voicebox-h")`);
    await tab.evaluate(`localStorage.setItem("via.mode", JSON.stringify("all")); localStorage.setItem("via.voice", JSON.stringify({ id: "v1aaaaa", label: "Bella - Professional, Bright, Warm" }))`);
    await tab.send("Page.navigate", { url: `${BASE}/?pause=${level}` });
    await waitFor(tab, `[...document.querySelectorAll("button")].some((b) => b.textContent.startsWith("Scan & Summarize"))`);
    // Wait for the saved settings to be applied after the page loads (not the server-rendered default).
    const label = level[0].toUpperCase() + level.slice(1);
    await waitFor(tab, `([...document.querySelectorAll("[aria-labelledby=pause-label] button")].find((b) => b.getAttribute("aria-pressed") === "true")?.textContent ?? "").startsWith(${JSON.stringify(label)})`, 8000);
    const pressed = await tab.evaluate(`[...document.querySelectorAll("[aria-labelledby=pause-label] button")].find((b) => b.getAttribute("aria-pressed") === "true")?.textContent ?? ""`);
    await click(tab, "Scan & Summarize");
    await waitFor(tab, `window.__log.events.filter((e) => e.type === "playing").length >= 4`, 30000);
    const ev = (await log(tab)).events;
    const ends = ev.filter((e) => e.type === "ended").map((e) => e.t);
    const plays = ev.filter((e) => e.type === "playing").map((e) => e.t);
    const gaps = ends.slice(0, 3).map((t, i) => Math.round(plays[i + 1] - t));
    const ok = gaps.length === 3 && gaps.every((g) => Math.abs(g - expected) <= 150);
    check(`${level}: the silence between emails is ${expected} ms (audio prepared in advance)`, ok && pressed.startsWith(level[0].toUpperCase()), `measured ${gaps.join(", ")} ms; button "${pressed}"`);
    await tab.close();
  }

  // ---------- 5. No stale timers or double playback ----------
  {
    const tab = await openTab();
    await tab.evaluate(`localStorage.clear()`);
    await tab.send("Page.navigate", { url: `${BASE}/?pause=slow` });
    await waitFor(tab, `!!document.querySelector("#voicebox-h")`);
    await tab.evaluate(`localStorage.setItem("via.mode", JSON.stringify("all")); localStorage.setItem("via.voice", JSON.stringify({ id: "v1aaaaa", label: "Bella" })); window.__cfg.clipSec = 0.6`);
    await click(tab, "Scan & Summarize");
    const betweenNow = () => waitFor(tab, `(document.querySelector("#player-h")?.closest("section")?.querySelector("[role=status]")?.textContent ?? "").startsWith("Next email in")`, 15000);

    await betweenNow();
    await click(tab, "Stop here");
    const p1 = await playingCount(tab);
    await sleep(2500);
    check("'Stop here' during the pause cancels the next email", (await playingCount(tab)) === p1, `${(await playingCount(tab)) - p1} started`);
    await click(tab, "Next →");
    await betweenNow();
    await tab.evaluate(`[...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.startsWith("Personal")).click()`);
    const p2 = await playingCount(tab);
    await sleep(2500);
    check("switching tabs during the pause cancels the pending email", (await playingCount(tab)) === p2, `${(await playingCount(tab)) - p2} started`);
    await tab.evaluate(`[...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.startsWith("All")).click()`);
    await click(tab, "▶ Listen");
    await betweenNow();
    await tab.evaluate(`Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange"))`);
    const p3 = await playingCount(tab);
    await sleep(2500);
    check("leaving (page hidden) during the pause cancels the pending email", (await playingCount(tab)) === p3, `${(await playingCount(tab)) - p3} started`);
    await tab.evaluate(`Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })`);
    await tab.evaluate(`window.__cfg.clipSec = 3`);
    await click(tab, "Next →");
    await waitFor(tab, `!document.querySelector("audio").paused`, 10000);
    await tab.evaluate(`Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange"))`);
    await sleep(300);
    check("leaving while an email plays pauses it (resumable)", (await tab.evaluate(`document.querySelector("audio").paused`)) && (await statusText(tab)).startsWith("Paused"), await statusText(tab));
    const l = await log(tab);
    const perText = new Map();
    for (const t of l.tts) perText.set(t.text, (perText.get(t.text) ?? 0) + 1);
    check("each email's audio was made at most once (no duplicate requests)", [...perText.values()].every((n) => n === 1), JSON.stringify([...perText.values()]));
    await tab.close();
  }

  // ---------- 6. One pause setting shared with the extension panel ----------
  {
    const parent = createServer((_, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<script>window.__got=[];addEventListener("message",(e)=>window.__got.push(e.data))</script><iframe id="app" src="${BASE}/?pause=fast" style="width:420px;height:900px"></iframe>`);
    });
    await new Promise((r) => parent.listen(4014, "127.0.0.1", r));
    const tab = await openTab();
    await tab.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await tab.send("Network.setCookie", { name: "authjs.session-token", value: SESSION, url: `${BASE}/`, path: "/", httpOnly: true, secure: true, sameSite: "None" });
    await tab.send("Page.navigate", { url: "http://127.0.0.1:4014/" });
    let frame = null;
    for (let i = 0; i < 60 && !frame; i++) {
      await sleep(250);
      frame = tab.sessions.find((s) => s.targetInfo.type === "iframe")?.sessionId ?? null;
    }
    const inFrame = (expr) => tab.evaluate(expr, frame);
    const pressed = () => inFrame(`[...document.querySelectorAll("[aria-labelledby=pause-label] button")].find((b) => b.getAttribute("aria-pressed") === "true")?.textContent ?? ""`);
    let first = "";
    for (let i = 0; i < 80 && !first; i++) {
      await sleep(250);
      first = frame ? await pressed() : "";
    }
    check("the panel's saved pause reaches the app (?pause=fast)", first.startsWith("Fast"), first);
    await tab.evaluate(`document.getElementById("app").contentWindow.postMessage({ type: "via-settings", pause: "slow" }, "*")`);
    await sleep(400);
    check("changing it on the Options page updates the open app", (await pressed()).startsWith("Slow"), await pressed());
    await inFrame(`[...document.querySelectorAll("[aria-labelledby=pause-label] button")].find((b) => b.textContent.startsWith("Medium")).click()`);
    await sleep(400);
    const got = await tab.evaluate("window.__got");
    check("changing it in the app tells the extension to save it", got.some((m) => m?.type === "via-pause-changed" && m?.pause === "medium"), JSON.stringify(got));
    await tab.close();
    parent.close();
  }
} catch (err) {
  check("flows ran", false, err?.stack ?? String(err));
}
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\nFAILED: ${failed} of ${results.length}` : `\nAll ${results.length} checks passed.`);
chrome.kill();
process.exit(failed ? 1 : 0);
