/**
 * Spoken-order tests (no network, no API keys): run with `npm.cmd test`.
 * Set PRINT=1 to also print exactly what would be spoken for All and every tab.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQueue, composeSpoken, stripLeadIns, withSpoken, type Group, type QueueItem } from "./triage.ts";

/** Gemini-style outputs, in inbox order (mixed on purpose). Each email got its own lead-in. */
const INBOX = [
  { id: "t1", from: "Amazon.com <auto-confirm@amazon.com>", subject: "Your order has shipped", output: "Finally, Transactions.\n\nYour Amazon order for the Logitech MX Master 3S Wireless Mouse, ninety-nine dollars and ninety-nine cents, has shipped via UPS and arrives Tuesday, November 17th." },
  { id: "s1", from: "Dr. Elena Vance <evance@university.edu>", subject: "BIO-204: Lab Report 4 Extension", output: "Starting with Work and School.\n\nFor Biology 204 with Doctor Elena Vance, Lab Report 4 is due Monday, November 16th at 11:59 PM." },
  { id: "p1", from: "Jordan Taylor <jtaylor99@gmail.com>", subject: "Friday night?", output: "Next, Personal.\n\nJordan Taylor asked if you are still up for ramen on Friday at 7:00 PM and needs a reply." },
  { id: "w1", from: "Priya Shah <priya@acme-corp.com>", subject: "Sprint planning moved", output: "Starting with Work and School.\n\nPriya Shah moved sprint planning for the Atlas project to Thursday at 2:00 PM." },
  // The route only passes spamReasons when strong evidence confirmed it (src/lib/spam.ts).
  { id: "spam", from: "Prize Desk <winner@prize-desk.example>", subject: "You have won a $500 gift card", output: "DISCARDED: SPAM", spamReasons: ["prize or lottery claim"] },
  { id: "t2", from: "Spotify <no-reply@spotify.com>", subject: "Your receipt", output: "Finally, Transactions.\n\nSpotify billed you eleven dollars and ninety-nine cents for Premium Individual." },
  { id: "s2", from: "Canvas <notifications@instructure.com>", subject: "CHEM 101 quiz posted", output: "Starting with Work and School. The Chemistry 101 quiz on stoichiometry opens Wednesday at 9:00 AM." },
  { id: "w2", from: "Marcus Lee <marcus@acme-corp.com>", subject: "Client deck", output: "Starting with Work and School.\n\nMarcus Lee needs the client deck for Brightline by Friday at noon." },
  { id: "t3", from: "Uber Eats <uber@uber.com>", subject: "Order confirmed", output: "Finally, Transactions.\n\nYour Uber Eats order from Sweetgreen, sixteen dollars and forty cents, is confirmed." },
  { id: "w3", from: "HR Team <hr@acme-corp.com>", subject: "Benefits enrollment", output: "Starting with Work and School.\n\nThe HR team says benefits enrollment closes November 30th." },
];

const NOTICE: QueueItem = {
  id: "sensitive-notice",
  from: "Voice Inbox Assistant",
  subject: "Sensitive emails skipped",
  category: "transactions",
  group: "skipped",
  body: "One more thing. I skipped two sensitive emails: one banking or financial email and one medical or health email.",
  summary: "",
};

function fullQueue(): QueueItem[] {
  return withSpoken([...buildQueue(INBOX), NOTICE]);
}

const TABS: Array<"all" | Exclude<Group, "skipped" | "spam">> = ["all", "work", "school", "personal", "transactions"];
// Like the player: the All tab never reads possible spam; it has its own tab.
const listFor = (q: QueueItem[], tab: (typeof TABS)[number]) => (tab === "all" ? q.filter((x) => x.group !== "spam") : q.filter((x) => x.group === tab));

test("queue is ordered Work, School, Personal, Transactions, possible spam, then the sensitive notice", () => {
  const q = fullQueue();
  assert.deepEqual(
    q.map((x) => x.id),
    ["w1", "w2", "w3", "s1", "s2", "p1", "t1", "t2", "t3", "spam", "sensitive-notice"],
  );
  const spam = q.find((x) => x.id === "spam")!;
  assert.equal(spam.group, "spam");
  assert.equal(spam.note, "possible-spam");
  assert.deepEqual(spam.reasons, ["prize or lottery claim"]);
  assert.equal(spam.summary, 'Possible spam from Prize Desk: "You have won a $500 gift card". I didn\'t read it.');
});

test("an AI failure or an unconfirmed spam answer is never dropped", () => {
  const q = buildQueue([
    { id: "fail", from: "Priya Shah <priya@acme.example>", subject: "Project deadline moved", output: null },
    { id: "unsure", from: "Daily Digest <news@digest.example>", subject: "Your weekly newsletter", output: "DISCARDED: SPAM" },
    { id: "empty", from: "Jordan <j@x.example>", subject: "Hi", output: "   " },
  ]);
  assert.deepEqual(q.map((x) => x.id).sort(), ["empty", "fail", "unsure"]);
  for (const item of q) {
    assert.equal(item.note, "unsummarized", item.id);
    assert.notEqual(item.group, "spam", item.id);
    assert.match(item.body, /^I couldn't summarize the email from .+ about ".+"\. You can read it in Gmail\.$/);
  }
  assert.equal(q.find((x) => x.id === "fail")!.group, "work", "keeps its likely section (deadline = work)");
});

test("School is only picked from whole words ('example' isn't 'exam', 'upgrade' isn't 'grade')", async () => {
  const { workOrSchool } = await import("./triage.ts");
  assert.equal(workOrSchool("Priya <p@acme.example>", "Project deadline", ""), "work");
  assert.equal(workOrSchool("Slack <no-reply@slack.com>", "Upgrade your workspace", ""), "work");
  assert.equal(workOrSchool("Canvas <notifications@instructure.com>", "Quiz posted", ""), "school");
  assert.equal(workOrSchool("Dr. Vance <v@university.edu>", "Office hours", ""), "school");
  assert.equal(workOrSchool("Prof Kim <k@x.com>", "Midterm grades are out", ""), "school");
});

test("no Gemini lead-in survives in any body", () => {
  for (const item of buildQueue(INBOX)) {
    assert.doesNotMatch(item.body, /starting with work|next, personal|finally, transactions/i, item.id);
  }
});

test("All tab: one intro per section, First/Finally inside each section", () => {
  const spoken = composeSpoken(listFor(fullQueue(), "all"));
  assert.deepEqual(spoken.map((s) => s.slice(0, 50)), [
    "Starting with Work, three emails. First, Priya Sha",
    "Second, Marcus Lee needs the client deck for Brigh",
    "Finally, the HR team says benefits enrollment clos",
    "Next, School, two emails. First, for Biology 204 w",
    "Finally, the Chemistry 101 quiz on stoichiometry o",
    "Next, Personal, one email. Jordan Taylor asked if ",
    "Lastly, Transactions, three emails. First, your Am",
    "Second, Spotify billed you eleven dollars and nine",
    "Finally, your Uber Eats order from Sweetgreen, six",
    "One more thing. I skipped two sensitive emails: on",
  ]);
});

test("each tab gets its own intro and First/Finally for exactly the emails in it", () => {
  const q = fullQueue();
  const expected: Record<string, string[]> = {
    work: ["You have three work emails. First,", "Second,", "Finally,"],
    school: ["You have two school emails. First,", "Finally,"],
    personal: ["You have one personal email. Jordan"],
    transactions: ["You have three transaction emails. First,", "Second,", "Finally,"],
  };
  for (const [tab, starts] of Object.entries(expected)) {
    const spoken = composeSpoken(listFor(q, tab as (typeof TABS)[number]));
    assert.equal(spoken.length, starts.length, tab);
    spoken.forEach((s, i) => assert.ok(s.startsWith(starts[i]!), `${tab}[${i}]: ${s}`));
  }
});

test("a section with one email has no First/Finally; two emails get First then Finally", () => {
  const one = composeSpoken([{ group: "personal", body: "Jordan asked about ramen." }]);
  assert.deepEqual(one, ["You have one personal email. Jordan asked about ramen."]);
  const two = composeSpoken([
    { group: "work", body: "Priya moved planning." },
    { group: "work", body: "Marcus needs the deck." },
  ]);
  assert.deepEqual(two, ["You have two work emails. First, Priya moved planning.", "Finally, Marcus needs the deck."]);
});

test("every spoken line in every tab has exactly one First and one Finally per section (2+ emails)", () => {
  const q = fullQueue();
  for (const tab of TABS) {
    const list = listFor(q, tab);
    const spoken = composeSpoken(list);
    const groups = [...new Set(list.map((x) => x.group).filter((g) => g !== "skipped"))];
    for (const g of groups) {
      const lines = spoken.filter((_, i) => list[i]!.group === g);
      if (lines.length < 2) continue;
      assert.equal(lines.filter((l) => /(^|\. )First, /.test(l)).length, 1, `${tab}/${g} First`);
      assert.equal(lines.filter((l) => l.startsWith("Finally, ")).length, 1, `${tab}/${g} Finally`);
      assert.ok(lines.at(-1)!.startsWith("Finally, "), `${tab}/${g} last line is Finally`);
    }
  }
});

test("butler and coach lead-in variants are removed", () => {
  assert.equal(stripLeadIns("Starting with Work and School, sir. Your lab report is due Monday, sir.").body, "Your lab report is due Monday, sir.");
  assert.equal(stripLeadIns("Next, Personal, if you please. Jordan wrote, sir.").body, "Jordan wrote, sir.");
  assert.equal(stripLeadIns("FINALLY, TRANSACTIONS!! Your Amazon order SHIPPED!").body, "Your Amazon order SHIPPED!");
  assert.equal(stripLeadIns("Starting with work and school, listen up! Lab Report 4 is DUE Monday!").body, "Lab Report 4 is DUE Monday!");
  assert.equal(stripLeadIns("Next, Personal emails. Jordan asked about ramen.").body, "Jordan asked about ramen.");
});

test("a lead-in merged into the summary keeps the summary", () => {
  const r = stripLeadIns("Starting with Work and School, for Biology 204 with Doctor Vance, the lab is due Monday.");
  assert.equal(r.body, "For Biology 204 with Doctor Vance, the lab is due Monday.");
  assert.equal(r.category, "work");
  const k = stripLeadIns("Starting with Work, Kim said hi.");
  assert.equal(k.body, "Kim said hi.");
});

test("real summary sentences that start with ordering words are not deleted", () => {
  assert.equal(stripLeadIns("Next, your work shift moved to Monday at 9 AM.").body, "Your work shift moved to Monday at 9 AM.");
  assert.equal(stripLeadIns("Next week, Priya wants to meet.").body, "Next week, Priya wants to meet.");
  assert.equal(stripLeadIns("Finally, the deck is done.").body, "The deck is done.");
});

test("First/Finally never doubles up and names keep their capital", () => {
  const [a, b] = composeSpoken([
    { group: "work", body: stripLeadIns("Starting with Work and School. First, Priya moved planning.").body },
    { group: "work", body: stripLeadIns("Finally, Marcus needs the deck.").body },
  ]);
  assert.equal(a, "You have two work emails. First, Priya moved planning.");
  assert.equal(b, "Finally, Marcus needs the deck.");
  const [c] = composeSpoken([{ group: "work", body: "YOUR REPORT IS LATE!" }, { group: "work", body: "Sir, the deck is due." }]);
  assert.equal(c, "You have two work emails. First, YOUR REPORT IS LATE!");
});

test("the sensitive notice is spoken last, unchanged, in All", () => {
  const spoken = composeSpoken(fullQueue());
  assert.equal(spoken.at(-1), NOTICE.body);
});

test("print the spoken order (PRINT=1)", () => {
  if (!process.env.PRINT) return;
  const q = fullQueue();
  for (const tab of TABS) {
    const list = listFor(q, tab);
    console.log(`\n=== ${tab.toUpperCase()} (${list.length}) ===`);
    composeSpoken(list).forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. [${list[i]!.group}] ${s}`));
  }
});
