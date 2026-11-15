// Screen-size audit with screenshots, using headless Chrome (DevTools protocol).
//   npm run check:ui                          -> http://localhost:3000
//   npm run check:ui -- https://vocamail.biz  -> the live site
//
// For each of 13 sizes (phones, tablets, desktop; portrait and landscape) it checks for
// sideways scrolling, content off-screen, cut-off text and voice names, and tap targets under
// 40px, in the Voice Box (all three tabs) and the player. It also checks that the styles were
// applied, that the app's scripts run (a tab click switches the player and its spoken text),
// and that no script error, console error or failed page/CSS/JS/font load happened.
// Self-test: UI_AUDIT_BLOCK=css or UI_AUDIT_BLOCK=js blocks those files, so the audit must fail.
// MOCK DATA, no credits: /api/emails and /api/tts are faked inside the page. /api/voices is the
// real list plus one fake, very long voice name to stress the layout. Signs in as a fake test
// user with the site's AUTH_SECRET (.env.live for the live site, .env.local for localhost).
// Set CHROME=/path/to/chrome if Chrome isn't in the usual place.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { encode } from "next-auth/jwt";

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
const isLocal = ["localhost", "127.0.0.1"].includes(new URL(BASE).hostname);
const OUT = join(tmpdir(), "voice-inbox-ui-audit");
mkdirSync(OUT, { recursive: true });

function readEnv(file) {
  const path = new URL(`../${file}`, import.meta.url);
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
  );
}
const secret = isLocal ? readEnv(".env.local").AUTH_SECRET : readEnv(".env.live").AUTH_SECRET;
if (!secret) {
  console.error(`No AUTH_SECRET in ${isLocal ? ".env.local" : ".env.live"}; can't sign in as a test user.`);
  process.exit(1);
}
const SESSION = await encode({
  secret,
  salt: "authjs.session-token",
  maxAge: 3600,
  token: { name: "UI Audit", email: "ui.audit@example.com", sub: "ui-audit", access_token: "placeholder-not-a-google-token", expires_at: Math.floor(Date.now() / 1000) + 3600, can_modify: true },
});

const CHROME =
  process.env.CHROME ??
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));
if (!CHROME) {
  console.error("Chrome not found. Set CHROME=/path/to/chrome.");
  process.exit(1);
}
const PORT = 9333;
// https://localhost (the server stack run on this computer) uses Caddy's local certificate.
const localHttps = isLocal && BASE.startsWith("https");
const chrome = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(OUT, "profile")}`, "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars", ...(localHttps ? ["--ignore-certificate-errors"] : []), "about:blank"],
  { stdio: "ignore" },
);
process.on("exit", () => chrome.kill());

for (let i = 0; i < 40; i++) {
  try {
    await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    break;
  } catch {
    await sleep(250);
  }
}
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
// Problems seen on the current page: script errors, console errors, and page/CSS/JS/font
// files that failed to load. Reset before each screen size.
let pageProblems = [];
const requestUrls = new Map();
const ASSET_TYPES = new Set(["Document", "Stylesheet", "Script", "Font"]);
const short = (url) => String(url).replace(BASE, "").slice(0, 80);
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(msg.error.message));
    else res(msg.result);
    return;
  }
  const p = msg.params ?? {};
  switch (msg.method) {
    case "Network.requestWillBeSent":
      requestUrls.set(p.requestId, p.request?.url);
      break;
    case "Network.responseReceived":
      if (ASSET_TYPES.has(p.type) && p.response?.status >= 400) pageProblems.push(`${p.type} ${short(p.response.url)} answered ${p.response.status}`);
      break;
    case "Network.loadingFailed":
      if (ASSET_TYPES.has(p.type) && !p.canceled) pageProblems.push(`${p.type} ${short(requestUrls.get(p.requestId))} failed: ${p.errorText || p.blockedReason || "blocked"}`);
      break;
    case "Runtime.exceptionThrown":
      pageProblems.push(`script error: ${(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "").split("\n")[0].slice(0, 160)}`);
      break;
    case "Runtime.consoleAPICalled":
      if (p.type === "error") pageProblems.push(`console error: ${(p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 160)}`);
      break;
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expr, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(expr)) return true;
    await sleep(200);
  }
  return false;
};

const MOCK = String.raw`(() => {
  const LONG = { voice_id: "mockLongNameVoice01", name: "Supercalifragilisticexpialidocious-Narrator-With-An-Extremely-Long-Name", category: "generated", description: "Mock voice with a very long unbroken name, used only to test the layout.", preview_url: null, created_at_unix: 1, removable: true, mine: true };
  try { localStorage.setItem("via.continuous", "false"); localStorage.setItem("via.voice", JSON.stringify({ id: LONG.voice_id, label: LONG.name })); } catch {}
  const B = (group, id, from, subject, body) => ({ id, from, subject, category: group === "school" ? "work" : group === "skipped" ? "transactions" : group, group, body, summary: body });
  const queue = [
    B("work", "w1", "Priya Shah <priya.shah@acme-corporation-international.example.com>", "Sprint planning for the Atlas project has moved to Thursday afternoon, please bring estimates", "Priya Shah moved sprint planning for the Atlas project to Thursday at 2:00 PM and asked you to bring your estimates."),
    B("work", "w2", "Marcus Lee <marcus@acme.example.com>", "Client deck", "Marcus Lee needs the client deck for Brightline by Friday at noon."),
    B("school", "s1", "Dr. Elena Vance <evance@university.edu>", "BIO-204: Lab Report 4 Extension", "For Biology 204 with Doctor Elena Vance, Lab Report 4 is due Monday, November 16th at 11:59 PM."),
    B("school", "s2", "Canvas <notifications@instructure.com>", "CHEM 101 quiz posted", "The Chemistry 101 quiz on stoichiometry opens Wednesday at 9:00 AM."),
    B("personal", "p1", "Jordan Taylor <jtaylor99@gmail.com>", "Friday night?", "Jordan Taylor asked if you are still up for ramen on Friday at 7:00 PM and needs a reply."),
    B("transactions", "t1", "Amazon.com <auto-confirm@amazon.com>", "Your order has shipped", "Your Amazon order for the Logitech MX Master 3S Wireless Mouse has shipped and arrives Tuesday, November 17th."),
    B("transactions", "t2", "Spotify <no-reply@spotify.com>", "Your receipt", "Spotify billed you eleven dollars and ninety-nine cents for Premium Individual."),
    { ...B("spam", "x1", "Lottery Board <win@intl-lotto.example>", "Congratulations, you have won!", "Possible spam from Lottery Board: \"Congratulations, you have won!\". I didn't read it."), note: "possible-spam", reasons: ["prize or lottery claim"] },
    B("skipped", "sensitive-notice", "Voice Inbox Assistant", "Sensitive emails skipped", "One more thing. I skipped two sensitive emails: one banking or financial email and one medical or health email."),
  ];
  function wav(sec) { const rate = 8000, n = Math.floor(rate * sec), b = new ArrayBuffer(44 + n), v = new DataView(b); const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0))); s(0, "RIFF"); v.setUint32(4, 36 + n, true); s(8, "WAVE"); s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, "data"); v.setUint32(40, n, true); for (let i = 0; i < n; i++) v.setUint8(44 + i, 128); return new Blob([b], { type: "audio/wav" }); }
  window.__tts = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init && init.method) || "GET";
    if (url.includes("/api/voices") && method === "GET" && !url.includes("/api/voices/")) {
      const res = await realFetch(input, init);
      if (!res.ok) return res;
      const json = await res.json();
      json.custom = [LONG, ...json.custom];
      return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/labels")) return new Response(JSON.stringify({ labels: [{ id: "Label_1", name: "A-very-long-label-name-for-client-projects-2026" }, { id: "Label_2", name: "Receipts" }, { id: "Label_3", name: "Work" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (/\/api\/emails\/[^/]+\/(trash|move)/.test(url)) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/api/emails")) {
      await new Promise((r) => setTimeout(r, 200));
      return new Response(JSON.stringify({ queue, stats: { fetched: 10, spam: 1, failed: 0, sensitive: 2, sensitiveByKind: { financial: 1, medical: 1 } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/tts")) {
      window.__tts.push(JSON.parse(init.body));
      await new Promise((r) => setTimeout(r, 100));
      return new Response(wav(0.4), { status: 200, headers: { "Content-Type": "audio/wav" } });
    }
    return realFetch(input, init);
  };
})();`;

const AUDIT = String.raw`(() => {
  const W = document.documentElement.clientWidth;
  const vis = (el) => { const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && b.width > 0 && b.height > 0 && !el.closest(".sr-only"); };
  const all = [...document.querySelectorAll("main *")].filter(vis);
  const offscreen = all.filter((el) => !el.closest(".overflow-y-auto")).filter((el) => { const b = el.getBoundingClientRect(); return b.right > W + 1 || b.left < -1; }).slice(0, 6).map((el) => el.tagName.toLowerCase() + ' "' + el.textContent.trim().slice(0, 30) + '"');
  const cutText = all.filter((el) => el.children.length === 0 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible").map((el) => el.textContent.trim().slice(0, 50));
  const names = [...document.querySelectorAll("li span[title]")].filter(vis);
  const voiceNamesCut = names.filter((n) => n.scrollWidth > n.clientWidth + 1 || n.getBoundingClientRect().right > W + 1).map((n) => n.textContent);
  const smallTargets = [...document.querySelectorAll("main button, main select, main [role=tab], main label.cursor-pointer, main input:not([type=checkbox]):not([type=radio]):not(.sr-only), main textarea")].filter(vis).filter((el) => { const b = el.getBoundingClientRect(); return b.height < 40 || b.width < 40; }).map((el) => (el.textContent.trim() || el.placeholder || el.tagName).slice(0, 25) + " " + Math.round(el.getBoundingClientRect().width) + "x" + Math.round(el.getBoundingClientRect().height));
  const readingWith = document.querySelector("#voicebox-h")?.parentElement?.querySelector("[role=status] span")?.textContent ?? "";
  return { sideways: document.documentElement.scrollWidth > W, offscreen, cutText, voiceNames: names.length, voiceNamesCut, smallTargets, readingWith };
})()`;

// Tailwind styles really applied (not just downloaded): the Scan button is filled and rounded,
// and the page column has its max width.
const STYLES_APPLIED = String.raw`(() => {
  const scan = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Scan & Summarize"));
  const main = document.querySelector("main");
  if (!scan || !main) return "Scan button or main column missing";
  const b = getComputedStyle(scan);
  const problems = [];
  if (document.styleSheets.length === 0) problems.push("no stylesheets attached");
  if (b.backgroundColor === "rgba(0, 0, 0, 0)" || b.backgroundColor === "transparent") problems.push("Scan button has no background color");
  if (!(parseFloat(b.borderTopLeftRadius) > 0)) problems.push("Scan button isn't rounded");
  if (getComputedStyle(main).maxWidth === "none") problems.push("page column has no max width");
  return problems.join("; ");
})()`;

await send("Page.enable");
await send("Network.enable");
await send("Runtime.enable");
const block = process.env.UI_AUDIT_BLOCK;
if (block === "css" || block === "js") {
  await send("Network.setBlockedURLs", { urls: [block === "css" ? "*.css" : "*/_next/static/*.js"] });
  console.log(`SELF-TEST: blocking ${block === "css" ? "stylesheets" : "scripts"}; every size should FAIL.\n`);
}
// SameSite=None cookies must be Secure, so on plain http (localhost) the cookie is left Lax.
const https = BASE.startsWith("https");
await send("Network.setCookie", { name: "authjs.session-token", value: SESSION, url: `${BASE}/`, path: "/", httpOnly: true, ...(https ? { secure: true, sameSite: "None" } : {}) });
await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });

const ALL_SIZES = [
  [320, 568], [375, 812], [390, 844], [430, 932], [768, 1024], [1024, 1366], [1440, 900],
  [568, 320], [812, 375], [844, 390], [932, 430], [1024, 768], [1366, 1024],
];
// UI_AUDIT_SIZES=320x568,1440x900 runs only those sizes.
const only = (process.env.UI_AUDIT_SIZES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SIZES = only.length ? ALL_SIZES.filter(([w, h]) => only.includes(`${w}x${h}`)) : ALL_SIZES;
const report = [];
let problems = 0;
for (const [width, height] of SIZES) {
  const portrait = height >= width;
  const mobile = Math.min(width, height) < 500;
  const tag = `${width}x${height}`;
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: width >= 1366 && !mobile ? 1 : 2, mobile, screenOrientation: { type: portrait ? "portraitPrimary" : "landscapePrimary", angle: portrait ? 0 : 90 } });
  await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  pageProblems = [];
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(800);
  const loadStart = Date.now();
  const voicesOk = await waitFor(`!!document.querySelector("li span[title]")`, 45000);
  const loadMs = Date.now() - loadStart + 800;
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 82 });
    writeFileSync(join(OUT, `${tag}-${name}.jpg`), Buffer.from(data, "base64"));
  };
  await evaluate(`window.scrollTo(0, 0)`);
  await sleep(200);
  await shot("1-voice-box");
  const issues = [];
  if (!voicesOk) issues.push("voice list never loaded (scripts not running, signed out, or wrong AUTH_SECRET)");
  const styleProblem = await evaluate(STYLES_APPLIED);
  if (styleProblem) issues.push(`styles not applied: ${styleProblem}`);
  let playerOk = false;
  if (voicesOk) {
    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Scan & Summarize"))?.click()`);
    playerOk = await waitFor(`!!document.querySelector("#player-h")`);
    if (!playerOk) issues.push("player never appeared after Scan");
  }
  if (playerOk) {
    await evaluate(`document.querySelector("[role=tablist][aria-label='Email categories']").scrollIntoView({ block: "start" }); window.scrollBy(0, -12)`);
    await sleep(300);
    await shot("2-player");
  }
  const views = { "voices + player": await evaluate(AUDIT) };
  // The app's scripts respond to clicks: the Work tab shows only work emails, with its own intro.
  if (playerOk) {
    await evaluate(`[...document.querySelectorAll("[role=tab]")].find((b) => b.textContent.startsWith("Work"))?.click()`);
    const switched = await waitFor(`(document.querySelector("#player-h")?.textContent ?? "").startsWith("Work email 1 of 2")`, 5000);
    const spoken = await evaluate(`document.querySelector("#player-h")?.closest("section")?.querySelector("p.text-lg")?.textContent ?? ""`);
    if (!switched) issues.push("clicking the Work tab didn't switch the player (scripts not running?)");
    else if (!spoken.startsWith("You have two work emails. First,")) issues.push(`Work tab spoken text is wrong: "${spoken.slice(0, 60)}"`);
    // Delete / Next / Reorganize, and the label picker (with a very long label name).
    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Reorganize"))?.click()`);
    if (!(await waitFor(`!!document.querySelector("[aria-label='Choose where to move this email'] li button")`, 5000))) issues.push("Reorganize label picker didn't open");
    await evaluate(`document.querySelector("[aria-label='Choose where to move this email']")?.scrollIntoView({ block: "center" })`);
    await sleep(200);
    await shot("3-reorganize");
    views["player actions + Reorganize"] = await evaluate(AUDIT);
    await evaluate(`[...document.querySelectorAll("[role=tab]")].find((b) => b.textContent.startsWith("Possible spam"))?.click()`);
    await sleep(300);
    views["Possible spam tab"] = await evaluate(AUDIT);
  }
  for (const label of ["Design a voice", "Clone a voice"]) {
    await evaluate(`[...document.querySelectorAll("[role=tab]")].find((b) => b.textContent === ${JSON.stringify(label)})?.click()`);
    await sleep(300);
    views[label] = await evaluate(AUDIT);
  }
  // The guided setup the Gmail button opens, all four steps.
  await send("Page.navigate", { url: `${BASE}/?setup=1` });
  if (await waitFor(`!!document.querySelector("#setup-h")`, 15000)) {
    for (let step = 1; step <= 4; step++) {
      if (step === 3) await waitFor(`!!document.querySelector("[aria-label=Voices] li")`, 15000);
      await evaluate(`document.querySelector("#setup-h").scrollIntoView({ block: "start" })`);
      await sleep(200);
      if (step === 3) await shot("4-setup-voices");
      views[`setup step ${step}`] = await evaluate(AUDIT);
      if (step < 4) await evaluate(`[...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Next →")?.click()`);
      await sleep(250);
    }
  } else issues.push("guided setup didn't open from ?setup=1");
  for (const [view, a] of Object.entries(views)) {
    if (a.sideways) issues.push(`${view}: page scrolls sideways`);
    if (a.offscreen.length) issues.push(`${view}: off-screen ${a.offscreen.join("; ")}`);
    if (a.cutText.length) issues.push(`${view}: cut-off text ${a.cutText.join("; ")}`);
    if (a.voiceNamesCut.length) issues.push(`${view}: cut-off voice names ${a.voiceNamesCut.join("; ")}`);
    if (a.smallTargets.length) issues.push(`${view}: small tap targets ${a.smallTargets.join("; ")}`);
  }
  for (const problem of new Set(pageProblems)) issues.push(problem);
  const main = views["voices + player"];
  if (voicesOk && !main.readingWith.startsWith("Supercalifragilistic")) issues.push(`"Reading with" shows "${main.readingWith}" instead of the selected voice`);
  problems += issues.length;
  report.push({ size: tag, orientation: portrait ? "portrait" : "landscape", voiceNamesChecked: main.voiceNames, voiceListMs: loadMs, issues });
  console.log(`${issues.length ? "FAIL" : "PASS"}  ${tag.padEnd(9)} ${portrait ? "portrait " : "landscape"}  ${main.voiceNames} voice names checked, voices loaded in ${(loadMs / 1000).toFixed(1)}s${issues.length ? `\n      ${issues.join("\n      ")}` : ""}`);
}
writeFileSync(join(OUT, "report.json"), JSON.stringify({ base: BASE, report }, null, 2));
console.log(`\n${problems ? `FAILED: ${problems} issue(s)` : `All ${SIZES.length} sizes passed`} on ${BASE}. Screenshots and report.json: ${OUT}`);
ws.close();
chrome.kill();
process.exit(problems ? 1 : 0);
