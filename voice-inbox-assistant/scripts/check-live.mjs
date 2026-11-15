// Checks the running site, several rounds in a row.
//   npm run check:live                                  -> https://vocamail.biz, 3 rounds
//   npm run check:live -- http://localhost:3000 2       -> another URL, 2 rounds
//   npm run check:live -- https://vocamail.biz 5 <sha>  -> also require that commit
//
// Public checks need nothing. Signed-in checks sign in as fake test users (placeholder Google
// tokens, no Gmail access) using the site's AUTH_SECRET: from .env.live for the live site, or
// .env.local for localhost. Nothing here spends Gemini or ElevenLabs credits: it reads the voice
// list and makes requests that must be refused before any paid call.
import { existsSync, readFileSync } from "node:fs";
import { resolve4 } from "node:dns/promises";
import { encode } from "next-auth/jwt";

const base = (process.argv[2] ?? "https://vocamail.biz").replace(/\/+$/, "");
const rounds = Number(process.argv[3] ?? 3);
const expectCommit = process.argv[4] ?? "";
const url = new URL(base);
const host = url.hostname;
const isLocal = ["localhost", "127.0.0.1"].includes(host);

function readEnv(file) {
  const path = new URL(`../${file}`, import.meta.url);
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
  );
}
const local = readEnv(".env.local");
// CHECK_AUTH_SECRET lets CI pass the live site's secret without writing a file.
const secret = process.env.CHECK_AUTH_SECRET || (isLocal ? local.AUTH_SECRET : readEnv(".env.live").AUTH_SECRET);
const adminEmail = (local.ADMIN_EMAILS ?? "").split(",")[0]?.trim() ?? "";

const session = (email) =>
  encode({
    secret,
    salt: "authjs.session-token",
    maxAge: 600,
    token: { email, name: email, sub: email, access_token: "placeholder-not-a-google-token", expires_at: Math.floor(Date.now() / 1000) + 600 },
  });

async function get(path, init = {}, cookie = "") {
  const started = performance.now();
  const headers = { ...(init.headers ?? {}), ...(cookie ? { cookie: `authjs.session-token=${cookie}` } : {}) };
  const res = await fetch(`${base}${path}`, { redirect: "manual", signal: AbortSignal.timeout(20000), ...init, headers });
  const body = await res.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  return { status: res.status, body, json, ms: Math.round(performance.now() - started) };
}

/** Same-site asset URLs referenced by these pages (deduplicated). */
async function assetsOf(pages, pattern) {
  const found = new Set();
  for (const page of pages) {
    const { body } = await get(page);
    for (const m of body.matchAll(pattern)) {
      const href = (m[1] ?? m[2] ?? "").replace(/&amp;/g, "&");
      if (href.startsWith("/") && !href.startsWith("//")) found.add(href);
    }
  }
  return [...found];
}

/** Downloads each asset; returns a description of every one that failed. */
async function checkAssets(files, typePattern) {
  const bad = [];
  await Promise.all(
    files.map(async (path) => {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20000) });
      const type = res.headers.get("content-type") ?? "";
      const size = (await res.arrayBuffer()).byteLength;
      if (res.status !== 200 || !typePattern.test(type) || size === 0) bad.push(`${path.slice(0, 60)} -> ${res.status} ${type || "no type"} ${size} bytes`);
    }),
  );
  return bad;
}

const PUBLIC = [
  ["DNS points at a server", async () => {
    if (isLocal) return [true, "skipped for localhost"];
    const ips = await resolve4(host);
    return [ips.length > 0, ips.join(", ")];
  }],
  ["www redirects to the main domain", async () => {
    if (isLocal) return [true, "skipped for localhost"];
    // A missing www DNS record is worth fixing but doesn't break the app: warn, don't fail.
    try {
      await resolve4(`www.${host}`);
    } catch {
      return ["warn", `no DNS record for www.${host} yet; add an A record`];
    }
    const res = await fetch(`https://www.${host}/`, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    const to = res.headers.get("location") ?? "";
    return [res.status >= 300 && res.status < 400 && to.startsWith(`https://${host}`), `${res.status} -> ${to}`];
  }],
  ["http:// redirects to https://", async () => {
    if (url.protocol !== "https:") return [true, "skipped (not https)"];
    const res = await fetch(`http://${host}/`, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    const to = res.headers.get("location") ?? "";
    return [res.status >= 300 && res.status < 400 && to.startsWith(`https://${host}`), `${res.status} -> ${to}`];
  }],
  ["/api/health is OK with all keys set", async () => {
    const r = await get("/api/health");
    const j = r.json ?? {};
    const keys = j.configured?.google && j.configured?.gemini && j.configured?.elevenlabs;
    const authOk = j.configured?.authUrl === base;
    const commitOk = !expectCommit || j.commit === expectCommit;
    return [r.status === 200 && j.ok === true && keys && authOk && commitOk, `commit ${j.commit}, keys ${keys ? "set" : "MISSING"}, AUTH_URL ${j.configured?.authUrl}, ${r.ms} ms`];
  }],
  ["home page (sign-in) loads", async () => {
    const r = await get("/");
    return [r.status === 200 && r.body.includes("Sign in with Google"), `${r.status}, ${r.ms} ms`];
  }],
  ["every stylesheet loads (home + privacy)", async () => {
    const files = await assetsOf(["/", "/privacy"], /<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"|<link[^>]+href="([^"]+\.css[^"]*)"[^>]*rel="stylesheet"/g);
    const bad = await checkAssets(files, /text\/css/);
    return [files.length > 0 && bad.length === 0, bad.length ? bad.join("; ") : `${files.length} stylesheet(s) OK`];
  }],
  ["every script loads (home + privacy)", async () => {
    const files = await assetsOf(["/", "/privacy"], /<script[^>]+src="([^"]+)"/g);
    const bad = await checkAssets(files, /javascript/);
    return [files.length > 0 && bad.length === 0, bad.length ? bad.join("; ") : `${files.length} script(s) OK`];
  }],
  ["privacy policy loads", async () => {
    const r = await get("/privacy");
    return [r.status === 200 && r.body.includes("Limited Use"), `${r.status}, ${r.ms} ms`];
  }],
  ["Google sign-in returns to this site", async () => {
    const r = await get("/api/auth/providers");
    const cb = r.json?.google?.callbackUrl ?? "";
    return [cb === `${base}/api/auth/callback/google`, cb || `status ${r.status}`];
  }],
  ["signed-out inbox scan is refused", async () => {
    const r = await get("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return [r.status === 401, `status ${r.status}`];
  }],
  ["signed-out voice list is refused", async () => {
    const r = await get("/api/voices");
    return [r.status === 401, `status ${r.status}`];
  }],
];

const SIGNED_IN = [
  ["signed-in voice list works", async (s) => {
    const r = await get("/api/voices", {}, s.a);
    s.voicesA = r.json;
    return [r.status === 200 && (r.json?.presets?.length ?? 0) > 0, `${r.status}, ${r.json?.presets?.length ?? 0} presets, ${r.json?.custom?.length ?? 0} other voices, ${r.ms} ms`];
  }],
  ["no private owner tags reach the browser", async (s) => {
    const all = [...(s.voicesA?.custom ?? []), ...(s.voicesA?.presets ?? [])];
    return [all.length > 0 && !all.some((v) => String(v.description).includes("via-owner")), `${all.length} voices checked`];
  }],
  ["a test user sees nobody else's cloned voice", async (s) => {
    const foreign = (s.voicesA?.custom ?? []).filter((v) => v.category === "cloned" && !v.mine);
    return [foreign.length === 0, foreign.map((v) => v.name).join(", ") || "none visible"];
  }],
  ["a second test user sees the same shared list", async (s) => {
    const r = await get("/api/voices", {}, s.b);
    const ids = (x) => JSON.stringify((x?.custom ?? []).map((v) => v.voice_id).sort());
    return [r.status === 200 && ids(r.json) === ids(s.voicesA), `${r.status}`];
  }],
  ["admin sees the older private clones", async (s) => {
    if (!s.admin) return [true, "skipped: no ADMIN_EMAILS in .env.local"];
    const r = await get("/api/voices", {}, s.admin);
    s.legacy = (r.json?.custom ?? []).find((v) => v.category === "cloned" && !v.mine);
    return [r.status === 200 && r.json?.mine?.limit === null, s.legacy ? `e.g. "${s.legacy.name}"` : "admin view OK, no older clones"];
  }],
  ["a test user can't make someone else's voice speak", async (s) => {
    if (!s.legacy) return [true, "skipped: no older clone to try"];
    const r = await get("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "test", voiceId: s.legacy.voice_id }) }, s.a);
    return [r.status === 403 && r.json?.code === "VOICE_NOT_YOURS", `${r.status} ${r.json?.code ?? ""}`];
  }],
  ["a test user can't delete someone else's voice", async (s) => {
    if (!s.legacy) return [true, "skipped: no older clone to try"];
    const r = await get(`/api/voices/${s.legacy.voice_id}`, { method: "DELETE" }, s.a);
    return [r.status === 403, `${r.status} ${r.json?.code ?? ""}`];
  }],
  ["Gmail rejects a fake token and the app asks to reconnect", async (s) => {
    const r = await get("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 1 }) }, s.a);
    return [r.status === 401 && r.json?.code === "SESSION_EXPIRED", `${r.status} ${r.json?.code ?? ""}`];
  }],
];

let failures = 0;
let ran = 0;
const signedIn = Boolean(secret);
for (let round = 1; round <= rounds; round++) {
  console.log(`\nRound ${round} of ${rounds}: ${base}`);
  const s = signedIn
    ? { a: await session("live.test.a@example.com"), b: await session("live.test.b@example.com"), admin: adminEmail ? await session(adminEmail) : null }
    : {};
  const checks = signedIn ? [...PUBLIC, ...SIGNED_IN] : PUBLIC;
  for (const [name, run] of checks) {
    let ok = false;
    let detail = "";
    try {
      [ok, detail] = await run(s);
    } catch (err) {
      detail = err?.cause?.code ?? err?.code ?? err?.message ?? String(err);
    }
    ran++;
    if (!ok) failures++;
    console.log(`  ${ok === "warn" ? "WARN" : ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  }
  if (!signedIn && round === 1) console.log(`  (signed-in checks skipped: no AUTH_SECRET in ${isLocal ? ".env.local" : ".env.live"})`);
  if (round < rounds) await new Promise((r) => setTimeout(r, 3000));
}
console.log(failures ? `\nFAILED: ${failures} of ${ran} checks across ${rounds} rounds.` : `\nAll ${ran} checks passed across ${rounds} rounds.`);
process.exit(failures ? 1 : 0);
