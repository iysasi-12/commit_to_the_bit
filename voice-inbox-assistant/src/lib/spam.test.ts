/** Conservative spam rules (no network): run with `npm.cmd test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmSpam, senderName, strongSpamSignals } from "./spam.ts";

const email = (from: string, subject: string, body: string, labels: string[] = ["INBOX"]) => ({ from, subject, body, labels });

test("legitimate mail the AI might call spam is NOT confirmed as spam", () => {
  const notSpam = [
    email("The Verge <newsletter@theverge.com>", "This week in tech", "Our top stories this week. Unsubscribe anytime.", ["INBOX", "CATEGORY_UPDATES"]),
    email("Target <deals@target.com>", "40% off this weekend only", "Shop the sale. Limited time offer. Unsubscribe.", ["INBOX", "CATEGORY_PROMOTIONS"]),
    email("Amazon.com <auto-confirm@amazon.com>", "Your order has shipped", "Order #114-8392019 will arrive Tuesday."),
    email("GitHub <noreply@github.com>", "[GitHub] A new SSH key was added", "If you did not add this key, review your account."),
    email("Sam Rivera <sam.r@unknown-startup.io>", "Quick intro", "Hi, I found your project and would love to chat about it."),
    email("Spotify <no-reply@spotify.com>", "Your receipt", "You paid $11.99 for Premium Individual."),
    email("LinkedIn <messages-noreply@linkedin.com>", "You appeared in 9 searches", "See who's looking at your profile."),
    email("Coinbase <no-reply@coinbase.com>", "Your weekly crypto market update", "Bitcoin prices moved 3% this week."),
  ];
  for (const e of notSpam) assert.deepEqual(confirmSpam(e), [], `${e.from} / ${e.subject}`);
});

test("clear scams and phishing are confirmed, with the reason", () => {
  const cases: Array<[ReturnType<typeof email>, string]> = [
    [email("Lottery Board <win@intl-lotto.example>", "Congratulations, you have won!", "Claim your prize of $850,000 now."), "prize or lottery claim"],
    [email("PayPaI Security <alert@paypa1-secure.example>", "Account notice", "Please verify your account password within 24 hours or it will be suspended."), "urgent demand to verify an account or lose it"],
    [email("CEO <ceo@company-mail.example>", "Urgent favor", "I need you to buy gift cards and send me the codes today."), "payment by wire, gift card or crypto"],
    [email("Barrister James <james@lawfirm.example>", "Inheritance", "You are the next of kin to an unclaimed fortune of ten million dollars."), "inheritance or windfall offer"],
  ];
  for (const [e, reason] of cases) assert.ok(confirmSpam(e).includes(reason), `${e.subject}: ${confirmSpam(e).join(", ")}`);
});

test("starred or Important emails are never treated as spam", () => {
  const scammy = email("Lottery Board <win@intl-lotto.example>", "You have won", "Claim your prize now.");
  assert.ok(strongSpamSignals(scammy).length > 0);
  assert.deepEqual(confirmSpam({ ...scammy, labels: ["INBOX", "STARRED"] }), []);
  assert.deepEqual(confirmSpam({ ...scammy, labels: ["INBOX", "IMPORTANT"] }), []);
});

test("sender names for display", () => {
  assert.equal(senderName("Jordan Taylor <jt@example.com>"), "Jordan Taylor");
  assert.equal(senderName('"Acme, Inc." <hi@acme.example>'), "Acme, Inc.");
  assert.equal(senderName("<plain@example.com>"), "plain@example.com");
});
