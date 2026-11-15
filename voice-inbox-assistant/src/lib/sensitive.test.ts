/** Sensitive-email handling (no network): run with `npm.cmd test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { scanWithoutSensitive, sensitiveKind, sensitiveNotice, type SensitiveKind } from "./sensitive.ts";
import { buildQueue, composeSpoken, withSpoken, type QueueItem } from "./triage.ts";

const SENSITIVE: Array<[SensitiveKind, string, string]> = [
  ["financial", "Chase <no.reply.alerts@chase.com>", "Your statement is ready"],
  ["financial", "Bank of America <onlinebanking@ealerts.bankofamerica.com>", "Account alert: low balance"],
  ["financial", "Navy Federal <noreply@navyfederal.org>", "Direct deposit received"],
  ["financial", "Payroll <hr@acme.example.com>", "Your 2026 W-2 is available"],
  ["financial", "Experian <alerts@experian.com>", "Your credit score changed"],
  ["medical", "MyChart <noreply@mychart.example.org>", "New test result available"],
  ["medical", "CVS Pharmacy <rx@cvs.com>", "Your prescription is ready for pickup"],
  ["medical", "Kaiser Permanente <noreply@kp.org>", "Appointment reminder: Dr. Lee on Tuesday"],
  ["medical", "Blue Cross Blue Shield <eob@bcbs.com>", "Explanation of Benefits"],
  ["government", "IRS <noreply@irs.gov>", "Your tax refund status"],
  ["government", "Social Security Administration <ssa@ssa.gov>", "Benefits notice"],
  ["government", "Michigan DMV <dmv@michigan.gov>", "Driver's license renewal"],
  ["security", "Google <no-reply@accounts.google.com>", "Security alert"],
  ["security", "Microsoft <account-security-noreply@accountprotection.microsoft.com>", "Your verification code"],
  ["security", "Instagram <security@mail.instagram.com>", "Reset your password"],
  ["security", "Steam <noreply@steampowered.com>", "Your Steam login code"],
  ["security", "Apple <no_reply@email.apple.com>", "New sign-in to your Apple Account"],
];

const NORMAL: Array<[string, string]> = [
  ["Amazon.com <auto-confirm@amazon.com>", "Your order has shipped"],
  ["Spotify <no-reply@spotify.com>", "Your receipt"],
  ["Dr. Elena Vance <evance@university.edu>", "BIO-204: Lab Report 4 Extension"],
  ["Canvas <notifications@instructure.com>", "CHEM 101 quiz posted"],
  ["Jordan Taylor <jtaylor99@gmail.com>", "Friday night?"],
  ["Priya Shah <priya@acme.example.com>", "Sprint planning moved"],
  ["Uber Eats <uber@uber.com>", "Your order is confirmed"],
];

test("sensitive senders and subjects are recognized", () => {
  for (const [kind, from, subject] of SENSITIVE) assert.equal(sensitiveKind(from, subject), kind, `${from} / ${subject}`);
});

test("ordinary work, school, personal and shopping emails are not flagged", () => {
  for (const [from, subject] of NORMAL) assert.equal(sensitiveKind(from, subject), null, `${from} / ${subject}`);
});

/** A fake Gmail that records every request, with secrets in the sensitive emails' bodies. */
function fakeInbox() {
  const all = [
    ...SENSITIVE.map(([, from, subject], i) => ({ id: `s${i}`, from, subject, body: `SECRET-${i}: account 4417-1234-5678-9113, balance $4,213.55, diagnosis on file` })),
    ...NORMAL.map(([from, subject], i) => ({ id: `n${i}`, from, subject, body: `Normal email ${i} about ${subject}.` })),
  ].sort(() => 0.5 - Math.random()); // inbox order shouldn't matter
  const fullRequests: string[] = [];
  const source = {
    listIds: async (n: number) => all.slice(0, n).map((e) => e.id),
    headers: async (id: string) => {
      const e = all.find((x) => x.id === id)!;
      return { id, from: e.from, subject: e.subject };
    },
    fullEmail: async (id: string) => {
      fullRequests.push(id);
      return all.find((x) => x.id === id)!;
    },
  };
  return { all, source, fullRequests };
}

test("a sensitive email's body is never downloaded; only its kind is counted", async () => {
  const { all, source, fullRequests } = fakeInbox();
  const scan = await scanWithoutSensitive(source, all.length);
  assert.equal(scan.fetched, all.length);
  assert.ok(fullRequests.every((id) => id.startsWith("n")), `downloaded in full: ${fullRequests.join(", ")}`);
  assert.equal(fullRequests.length, NORMAL.length);
  assert.ok(scan.emails.every((e) => !e.body.includes("SECRET")));
  assert.deepEqual(scan.sensitive, { financial: 5, medical: 4, government: 3, security: 5 });
});

test("the spoken note gives counts only, never a sender, subject, amount or detail", () => {
  const note = sensitiveNotice({ financial: 5, medical: 4, government: 3, security: 5 })!;
  assert.match(note, /^One more thing\. I skipped seventeen sensitive emails: /);
  for (const [, from, subject] of SENSITIVE) {
    const name = from.split("<")[0]!.trim();
    assert.ok(!note.includes(name), `note mentions "${name}"`);
    assert.ok(!note.toLowerCase().includes(subject.toLowerCase()), `note mentions "${subject}"`);
  }
  for (const secret of ["4417", "4,213", "diagnosis", "SECRET", "@"]) assert.ok(!note.includes(secret), `note contains "${secret}"`);
  assert.equal(sensitiveNotice({}), null, "nothing is said when nothing was skipped");
  assert.equal(sensitiveNotice({ medical: 1 }), "One more thing. I skipped one sensitive email: one medical or health email. For your privacy, I didn't open, summarize, or read it. You can check it yourself in Gmail.");
});

test("everything spoken or shown after a scan is free of sensitive details", async () => {
  const { all, source } = fakeInbox();
  const scan = await scanWithoutSensitive(source, all.length);
  // What the summarizer would produce for the emails it was given (only the safe ones).
  const outputs = scan.emails.map((e) => ({ id: e.id, from: e.from, subject: e.subject, output: `Starting with Work and School. ${e.body}` }));
  const notice = sensitiveNotice(scan.sensitive)!;
  const queue: QueueItem[] = withSpoken([
    ...buildQueue(outputs),
    { id: "sensitive-notice", from: "Voice Inbox Assistant", subject: "Sensitive emails skipped", category: "transactions", group: "skipped", body: notice, summary: notice },
  ]);
  const everything = JSON.stringify(queue) + composeSpoken(queue).join(" ");
  for (const [, from, subject] of SENSITIVE) {
    assert.ok(!everything.includes(from), `shows sender ${from}`);
    assert.ok(!everything.includes(subject), `shows subject ${subject}`);
  }
  for (const secret of ["SECRET", "4417-1234", "4,213.55", "diagnosis"]) assert.ok(!everything.includes(secret), `contains ${secret}`);
  assert.equal(queue.at(-1)!.id, "sensitive-notice", "the note comes last");
});
