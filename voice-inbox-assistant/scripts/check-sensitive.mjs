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

const log = { gmail: [], geminiBodies: [], badAuth: 0, queries: [], actions: [] };
const LABELS = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "Label_9", name: "Work", type: "user" },
  { id: "Label_3", name: "Receipts", type: "user" },
  { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
];
const NOT_SPAM_MARKER = "has already been checked and it is NOT spam";
const json = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let body = "";
  for await (const chunk of req) body += chunk;
  // ---- fake Gmail ----
  if (url.pathname === "/gmail/v1/users/me/labels") {
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) log.badAuth++;
    return json(res, 200, { labels: LABELS });
  }
  if (url.pathname.startsWith("/gmail/v1/users/me/messages")) {
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) log.badAuth++;
    const [id, action] = (url.pathname.split("/messages/")[1] ?? "").split("/");
    if (action) {
      // Changes: only ever made when the person clicks Delete or Reorganize.
      if (id === "noperm") return json(res, 403, { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } });
      log.actions.push({ id, action, method: req.method, body: body ? JSON.parse(body) : null });
      return json(res, 200, { id, labelIds: action === "trash" ? ["TRASH"] : ["Label_9"] });
    }
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
    const labelIds = email.labels ?? ["INBOX"];
    if (format === "metadata") return json(res, 200, { id: email.id, threadId: email.id, labelIds, payload: { headers } });
    return json(res, 200, {
      id: email.id,
      threadId: email.id,
      labelIds,
      snippet: email.body.slice(0, 80),
      internalDate: String(Date.now()),
      payload: { mimeType: "text/plain", headers: [...headers, { name: "Date", value: "Sun, 15 Nov 2026 09:00:00 -0500" }], body: { data: Buffer.from(email.body).toString("base64url") } },
    });
  }
  // ---- fake Gemini ----
  if (url.pathname.endsWith(":generateContent")) {
    log.geminiBodies.push(body);
    const subject = body.match(/Subject: ([^\\\n]+)/)?.[1] ?? "";
    const email = inbox.find((e) => e.subject === subject);
    // Per-email AI behavior for the spam phase: wrongly says spam until told it isn't, always
    // says spam, or fails outright.
    if (email?.ai === "fail") return json(res, 500, { error: { code: 500, message: "fake Gemini failure", status: "INTERNAL" } });
    let text = email?.summary ?? "DISCARDED: SPAM";
    if (email?.ai === "spam-until-told") text = body.includes(NOT_SPAM_MARKER) ? email.summary : "DISCARDED: SPAM";
    if (email?.ai === "always-spam") text = "DISCARDED: SPAM";
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

  // ---- Conservative spam, AI failures, and Delete / Reorganize ----
  inbox.length = 0;
  inbox.push(
    { id: "news", ageH: 1, from: "The Verge <newsletter@theverge.com>", subject: "This week in tech", labels: ["INBOX", "CATEGORY_UPDATES"], body: "Our top stories this week. Unsubscribe anytime.", ai: "spam-until-told", summary: "Finally, Transactions. The Verge newsletter covers this week's top tech stories." },
    { id: "promo", ageH: 2, from: "Target <deals@target.com>", subject: "40% off this weekend only", labels: ["INBOX", "CATEGORY_PROMOTIONS"], body: "Shop the weekend sale. Limited time.", ai: "spam-until-told", summary: "Finally, Transactions. Target is running a 40 percent off sale this weekend." },
    { id: "receipt", ageH: 3, from: "Spotify <no-reply@spotify.com>", subject: "Your receipt", body: "You paid $11.99 for Premium Individual.", summary: "Finally, Transactions. Spotify billed you eleven dollars and ninety-nine cents." },
    { id: "raffle", ageH: 4, from: "Office Social Club <social@acme.example>", subject: "You have won the office raffle", labels: ["INBOX", "STARRED"], body: "Congratulations, you won! Claim your prize at the front desk.", ai: "spam-until-told", summary: "Next, Personal. You won the office raffle; pick up your prize at the front desk." },
    { id: "scam", ageH: 5, from: "Lottery Board <win@intl-lotto.example>", subject: "Congratulations, you have won!", body: "You have won $850,000. Claim your prize now by replying with your bank details.", ai: "always-spam" },
    { id: "broken", ageH: 6, from: "Priya Shah <priya@acme.example>", subject: "Quarterly report deadline", body: "Please send the quarterly report by Friday.", ai: "fail" },
  );
  const changesBefore = log.actions.length;
  const s2 = await fetch(`${base}/api/emails`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `authjs.session-token=${session}` },
    body: JSON.stringify({ count: 10 }),
    signal: AbortSignal.timeout(180000),
  });
  const d2 = await s2.json().catch(() => null);
  const q2 = d2?.queue ?? [];
  const item = (id) => q2.find((x) => x.id === id);
  check("spam phase: scan succeeds", s2.status === 200, `${s2.status} ${d2?.code ?? ""}`);
  for (const id of ["news", "promo", "receipt", "raffle"]) {
    const it = item(id);
    check(`not spam, summarized normally: ${id}`, Boolean(it) && it.group !== "spam" && !it.note && !it.body.startsWith("I couldn't"), it ? `${it.group}: ${it.body.slice(0, 60)}` : "missing");
  }
  check("the newsletter and promotion were re-checked, not discarded", d2?.stats?.recheckedNotSpam === 3, `re-checked ${d2?.stats?.recheckedNotSpam}`);
  check("a starred email is never treated as spam, even if it looks like a prize email", item("raffle")?.group === "personal", item("raffle")?.group);
  const scam = item("scam");
  check("a clear scam is set aside as possible spam, with the reason", scam?.group === "spam" && scam?.note === "possible-spam" && scam?.reasons?.includes("prize or lottery claim"), JSON.stringify(scam?.reasons));
  const broken = item("broken");
  check("an AI failure is listed, not hidden", broken?.note === "unsummarized" && broken?.group !== "spam" && /couldn't summarize the email from Priya Shah/.test(broken?.body ?? ""), broken?.body);
  check("stats: 1 possible spam, 1 couldn't be summarized", d2?.stats?.spam === 1 && d2?.stats?.failed === 1, JSON.stringify({ spam: d2?.stats?.spam, failed: d2?.stats?.failed }));
  check("scanning never moves, deletes or relabels anything in Gmail", log.actions.length === changesBefore, `${log.actions.length - changesBefore} changes`);

  const post = (path, payload) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", cookie: `authjs.session-token=${session}` }, body: JSON.stringify(payload ?? {}) });
  const del = await post("/api/emails/receipt/trash");
  check("Delete moves exactly that email to Trash", del.status === 200 && log.actions.at(-1)?.id === "receipt" && log.actions.at(-1)?.action === "trash", `${del.status}`);
  const lab = await fetch(`${base}/api/labels`, { headers: { cookie: `authjs.session-token=${session}` } });
  const labels = (await lab.json().catch(() => null))?.labels ?? [];
  check("Reorganize lists only your own labels, sorted", lab.status === 200 && JSON.stringify(labels.map((l) => l.name)) === JSON.stringify(["Receipts", "Work"]), JSON.stringify(labels));
  const mv = await post("/api/emails/news/move", { labelId: "Label_9" });
  const last = log.actions.at(-1);
  check(
    "Reorganize adds the label and only removes INBOX (other labels kept)",
    mv.status === 200 && last?.action === "modify" && JSON.stringify(last?.body) === JSON.stringify({ addLabelIds: ["Label_9"], removeLabelIds: ["INBOX"] }),
    JSON.stringify(last?.body),
  );
  const before = log.actions.length;
  const bad = await post("/api/emails/bad%20id!/trash");
  const badLabel = await post("/api/emails/news/move", { labelId: "../../x" });
  check("invalid email or label ids are refused without touching Gmail", bad.status === 400 && badLabel.status === 400 && log.actions.length === before, `${bad.status}, ${badLabel.status}`);
  const noperm = await post("/api/emails/noperm/trash");
  const np = await noperm.json().catch(() => null);
  check("an old read-only sign-in gets a clear 'sign in again' answer", noperm.status === 403 && np?.code === "GMAIL_NEEDS_PERMISSION", `${noperm.status} ${np?.code}`);
  const anonDel = await fetch(`${base}/api/emails/receipt/trash`, { method: "POST" });
  check("signed-out Delete is refused", anonDel.status === 401, `${anonDel.status}`);
} catch (err) {
  check("test ran", false, err?.message ?? String(err));
} finally {
  server.close();
}
console.log(`Sensitive-email test against ${base}\n${results.join("\n")}`);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\nFAILED: ${failed} of ${results.length}` : `\nAll ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
