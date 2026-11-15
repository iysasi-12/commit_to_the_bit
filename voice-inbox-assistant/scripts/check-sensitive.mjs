// End-to-end proof that sensitive emails are never read, summarized, shown or spoken, and that
// the "last 8 / 16 / 48 hours" windows return exactly the right emails.
//   npm run check:sensitive -- http://localhost:3300
//
// It starts a fake Gmail and a fake Gemini on this computer (port 4010) and scans through the
// app's real /api/emails route. The app under test must be started with
//   GMAIL_API_ROOT=http://127.0.0.1:4010/   GEMINI_API_BASE=http://127.0.0.1:4010
// (for Docker: http://host.docker.internal:4010/). Never set those on the real server.
// The fake inbox has 17 sensitive emails whose bodies hold fake account numbers, balances and
// diagnoses, plus 7 ordinary ones. No real inbox, Gemini quota or ElevenLabs credits are used.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { encode } from "next-auth/jwt";

const base = (process.argv[2] ?? "http://localhost:3300").replace(/\/+$/, "");
const PORT = Number(process.env.MOCK_PORT ?? 4010);
const isLocal = ["localhost", "127.0.0.1"].includes(new URL(base).hostname);
const FAKE_TOKEN = "e2e-fake-google-token";

function readEnv(file) {
  const path = new URL(`../${file}`, import.meta.url);
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
}
const secret = (isLocal ? readEnv(".env.local") : readEnv(".env.live")).AUTH_SECRET;

const SENSITIVE = [
  ["Chase <no.reply.alerts@chase.com>", "Your statement is ready"],
  ["Bank of America <onlinebanking@ealerts.bankofamerica.com>", "Account alert: low balance"],
  ["Navy Federal <noreply@navyfederal.org>", "Direct deposit received"],
  ["Payroll <hr@acme.example.com>", "Your 2026 W-2 is available"],
  ["Experian <alerts@experian.com>", "Your credit score changed"],
  ["MyChart <noreply@mychart.example.org>", "New test result available"],
  ["CVS Pharmacy <rx@cvs.com>", "Your prescription is ready for pickup"],
  ["Kaiser Permanente <noreply@kp.org>", "Appointment reminder: Dr. Lee on Tuesday"],
  ["Blue Cross Blue Shield <eob@bcbs.com>", "Explanation of Benefits"],
  ["IRS <noreply@irs.gov>", "Your tax refund status"],
  ["Social Security Administration <ssa@ssa.gov>", "Benefits notice"],
  ["Michigan DMV <dmv@michigan.gov>", "Driver's license renewal"],
  ["Google <no-reply@accounts.google.com>", "Security alert"],
  ["Microsoft <account-security-noreply@accountprotection.microsoft.com>", "Your verification code"],
  ["Instagram <security@mail.instagram.com>", "Reset your password"],
  ["Steam <noreply@steampowered.com>", "Your Steam login code"],
  ["Apple <no_reply@email.apple.com>", "New sign-in to your Apple Account"],
];
const NORMAL = [
  ["Amazon.com <auto-confirm@amazon.com>", "Your order has shipped", "Finally, Transactions. Your Amazon order for a desk lamp has shipped."],
  ["Spotify <no-reply@spotify.com>", "Your receipt", "Finally, Transactions. Spotify billed you eleven dollars for Premium."],
  ["Dr. Elena Vance <evance@university.edu>", "BIO-204: Lab Report 4 Extension", "Starting with Work and School. Lab Report 4 for Biology 204 is due Monday."],
  ["Canvas <notifications@instructure.com>", "CHEM 101 quiz posted", "Starting with Work and School. The Chemistry 101 quiz opens Wednesday."],
  ["Jordan Taylor <jtaylor99@gmail.com>", "Friday night?", "Next, Personal. Jordan Taylor asked about ramen on Friday."],
  ["Priya Shah <priya@acme.example.com>", "Sprint planning moved", "Starting with Work and School. Priya Shah moved sprint planning to Thursday."],
  ["Uber Eats <uber@uber.com>", "Your order is confirmed", "Finally, Transactions. Your Uber Eats order is confirmed."],
];
const SECRETS = ["SECRET-MARKER", "4417-1234-5678-9113", "$4,213.55", "acute bronchitis", "SSN 123-45-6789", "PIN 9341"];
// Each email has an age in hours, so the 8/16/48-hour windows can be checked too.
const SENSITIVE_AGES = [1, 5, 12, 20, 30, 60];
const NORMAL_AGES = [2, 6, 10, 15, 30, 40, 70];
const NOW = Date.now();
const inbox = [
  ...SENSITIVE.map(([from, subject], i) => ({ id: `sens${i}`, from, subject, ageH: SENSITIVE_AGES[i % SENSITIVE_AGES.length], body: `SECRET-MARKER ${i}. Account 4417-1234-5678-9113, balance $4,213.55. Diagnosis: acute bronchitis. SSN 123-45-6789. PIN 9341.` })),
  ...NORMAL.map(([from, subject, summary], i) => ({ id: `norm${i}`, from, subject, ageH: NORMAL_AGES[i], body: `Hello, this is an ordinary email number ${i}.`, summary })),
];
// Newest first, like a real inbox.
inbox.sort((a, b) => a.ageH - b.ageH);
const sentAt = (e) => NOW - e.ageH * 3_600_000;

const log = { gmail: [], geminiBodies: [], badAuth: 0, queries: [] };
const json = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let body = "";
  for await (const chunk of req) body += chunk;
  // ---- fake Gmail ----
  if (url.pathname.startsWith("/gmail/v1/users/me/messages")) {
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) log.badAuth++;
    const id = url.pathname.split("/messages/")[1];
    if (!id) {
      const n = Number(url.searchParams.get("maxResults") ?? 10);
      // Like Gmail search: "after:<unix seconds>" keeps only emails sent after that moment.
      const q = url.searchParams.get("q");
      log.queries.push(q);
      const after = Number(q?.match(/^after:(\d+)$/)?.[1] ?? 0) * 1000;
      const listed = inbox.filter((e) => sentAt(e) > after).slice(0, n);
      return json(res, 200, { messages: listed.map((e) => ({ id: e.id, threadId: e.id })), resultSizeEstimate: listed.length });
    }
    const email = inbox.find((e) => e.id === decodeURIComponent(id));
    if (!email) return json(res, 404, { error: { code: 404, message: "Not found" } });
    const format = url.searchParams.get("format") ?? "full";
    log.gmail.push({ id: email.id, format });
    const headers = [
      { name: "From", value: email.from },
      { name: "Subject", value: email.subject },
    ];
    if (format === "metadata") return json(res, 200, { id: email.id, threadId: email.id, payload: { headers } });
    return json(res, 200, {
      id: email.id,
      threadId: email.id,
      snippet: email.body.slice(0, 80),
      internalDate: String(Date.now()),
      payload: { mimeType: "text/plain", headers: [...headers, { name: "Date", value: "Sun, 15 Nov 2026 09:00:00 -0500" }], body: { data: Buffer.from(email.body).toString("base64url") } },
    });
  }
  // ---- fake Gemini ----
  if (url.pathname.endsWith(":generateContent")) {
    log.geminiBodies.push(body);
    const subject = body.match(/Subject: ([^\\\n]+)/)?.[1] ?? "";
    const text = inbox.find((e) => e.subject === subject)?.summary ?? "DISCARDED: SPAM";
    return json(res, 200, { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }], modelVersion: "fake" });
  }
  json(res, 404, { error: "unknown fake route" });
});
await new Promise((r) => server.listen(PORT, "0.0.0.0", r));

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
try {
  if (!secret) throw new Error(`No AUTH_SECRET in ${isLocal ? ".env.local" : ".env.live"}`);
  const session = await encode({ secret, salt: "authjs.session-token", maxAge: 600, token: { email: "sensitive.test@example.com", sub: "sens", access_token: FAKE_TOKEN, expires_at: Math.floor(Date.now() / 1000) + 600 } });
  const res = await fetch(`${base}/api/emails`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `authjs.session-token=${session}` },
    body: JSON.stringify({ count: inbox.length, length: "medium", persona: "standard" }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  check("scan through the real /api/emails route succeeds", res.status === 200 && Array.isArray(data?.queue), `${res.status} ${data?.code ?? ""} ${data?.error ?? ""}`.trim());
  check("the app used the fake Gmail (not a real inbox)", log.gmail.length > 0 && log.badAuth === 0, `${log.gmail.length} Gmail requests`);

  const fullIds = log.gmail.filter((r) => r.format === "full").map((r) => r.id);
  const metaIds = log.gmail.filter((r) => r.format === "metadata").map((r) => r.id);
  check("every email was first checked by sender and subject only", metaIds.length === inbox.length, `${metaIds.length} of ${inbox.length}`);
  check("no sensitive email was downloaded in full", fullIds.every((id) => id.startsWith("norm")) && fullIds.length === NORMAL.length, `full downloads: ${fullIds.join(", ")}`);

  const toAi = log.geminiBodies.join("\n");
  check("the AI received only the ordinary emails", log.geminiBodies.length === NORMAL.length, `${log.geminiBodies.length} summaries requested`);
  const leakedToAi = [...SECRETS, ...SENSITIVE.flatMap(([f, s]) => [f.split("<")[0].trim(), s])].filter((x) => toAi.includes(x));
  check("nothing from a sensitive email reached the AI", leakedToAi.length === 0, leakedToAi.join("; ") || "no secrets, senders or subjects");

  const shown = JSON.stringify(data ?? {});
  const leakedToScreen = [...SECRETS, ...SENSITIVE.flatMap(([f, s]) => [f, s])].filter((x) => shown.includes(x));
  check("nothing from a sensitive email is shown or spoken", leakedToScreen.length === 0, leakedToScreen.join("; ") || "checked every summary, sender, subject and stat");

  const queue = data?.queue ?? [];
  const note = queue.at(-1);
  check("the sensitive note comes last and only gives counts", note?.id === "sensitive-notice" && /^One more thing\. I skipped seventeen sensitive emails: /.test(note?.summary ?? ""), note?.summary?.slice(0, 120));
  check("the 7 ordinary emails are all summarized", queue.filter((q) => q.group !== "skipped").length === NORMAL.length, `${queue.length - 1} summaries`);
  const byKind = data?.stats?.sensitiveByKind ?? {};
  const expectedKinds = { financial: 5, medical: 4, government: 3, security: 5 };
  check(
    "stats count the skipped emails by kind only",
    data?.stats?.sensitive === 17 && Object.keys(byKind).length === 4 && Object.entries(expectedKinds).every(([k, n]) => byKind[k] === n),
    JSON.stringify(byKind),
  );
  check("with no time window, Gmail is asked for the newest emails (no cutoff)", log.queries[0] === null, `query ${log.queries[0]}`);

  // ---- Time windows: last 8, 16 and 48 hours ----
  for (const hours of [8, 16, 48]) {
    const before = { queries: log.queries.length, full: log.gmail.filter((r) => r.format === "full").length, ai: log.geminiBodies.length };
    const r = await fetch(`${base}/api/emails`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `authjs.session-token=${session}` },
      body: JSON.stringify({ count: 50, hours, length: "short", persona: "standard" }),
      signal: AbortSignal.timeout(120000),
    });
    const d = await r.json().catch(() => null);
    const q = log.queries[before.queries] ?? "";
    const cutoff = Number(q.match(/^after:(\d+)$/)?.[1] ?? 0) * 1000;
    const expectedCutoff = Date.now() - hours * 3_600_000;
    const inWindow = inbox.filter((e) => e.ageH < hours);
    const normalIn = inWindow.filter((e) => e.id.startsWith("norm"));
    const sensitiveIn = inWindow.filter((e) => e.id.startsWith("sens"));
    const summarized = (d?.queue ?? []).filter((x) => x.group !== "skipped");
    const fullNow = log.gmail.filter((x) => x.format === "full").slice(before.full).map((x) => x.id);
    const leaked = [...SECRETS, ...SENSITIVE.flatMap(([f, s]) => [f, s])].filter((x) => JSON.stringify(d ?? {}).includes(x) || log.geminiBodies.slice(before.ai).join("\n").includes(x));
    check(
      `last ${hours} hours: Gmail is asked only for emails after the right moment`,
      Math.abs(cutoff - expectedCutoff) < 120_000,
      q ? `${q} = ${new Date(cutoff).toISOString()}` : "no cutoff sent",
    );
    check(
      `last ${hours} hours: exactly the ${normalIn.length} ordinary + ${sensitiveIn.length} sensitive emails from that window`,
      r.status === 200 && d?.stats?.fetched === inWindow.length && summarized.length === normalIn.length && d?.stats?.sensitive === sensitiveIn.length && d?.stats?.hours === hours,
      `${r.status}: checked ${d?.stats?.fetched}, summarized ${summarized.length}, sensitive ${d?.stats?.sensitive}`,
    );
    check(`last ${hours} hours: still nothing sensitive downloaded, sent to the AI or shown`, fullNow.every((id) => id.startsWith("norm")) && leaked.length === 0, leaked.join("; ") || `${fullNow.length} ordinary emails downloaded`);
  }
  // Anything other than 8/16/48 is ignored (no cutoff), never an error.
  const odd = await fetch(`${base}/api/emails`, { method: "POST", headers: { "Content-Type": "application/json", cookie: `authjs.session-token=${session}` }, body: JSON.stringify({ count: 5, hours: 24 }), signal: AbortSignal.timeout(120000) });
  check("an unsupported window (24 hours) falls back to newest emails", odd.status === 200 && log.queries.at(-1) === null, `${odd.status}, query ${log.queries.at(-1)}`);
} catch (err) {
  check("test ran", false, err?.message ?? String(err));
} finally {
  server.close();
}
console.log(`Sensitive-email test against ${base}\n${results.join("\n")}`);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\nFAILED: ${failed} of ${results.length}` : `\nAll ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
