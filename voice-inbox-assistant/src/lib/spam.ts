/**
 * Conservative spam handling (pure, no network).
 *
 * The AI's "DISCARDED: SPAM" alone is NOT enough. An email is set aside as "possible spam" only
 * when the AI says spam AND the email itself shows strong evidence (scam/phishing patterns).
 * Newsletters, promotions, receipts, automated notices and unknown senders don't count.
 * Starred or Important emails are never treated as spam (the person or Gmail marked them).
 * Possible spam is only listed separately in the app: nothing is ever moved, deleted or hidden.
 * Gmail's own Spam folder is a different thing: those emails aren't in the Inbox, so they're
 * never scanned at all.
 */

export interface SpamInput {
  from: string;
  subject: string;
  body: string;
  labels: string[];
}

const STRONG_SIGNALS: Array<[RegExp, string]> = [
  [/\b(you('ve| have)? (won|been selected)|claim (your )?(prize|reward|winnings|gift card)|lottery|sweepstakes winner|jackpot)\b/i, "prize or lottery claim"],
  [
    /\b(verify|confirm|update|validate)\b[\s\S]{0,40}\b(account|password|identity|billing|payment details?)\b[\s\S]{0,80}\b(suspend|suspended|locked|disabled|terminated|within 24 hours|immediately|or (it|your account) will)\b/i,
    "urgent demand to verify an account or lose it",
  ],
  [/\b(wire transfer|western union|moneygram|gift ?cards?|bitcoin|btc|usdt|crypto ?(wallet|currency))\b[\s\S]{0,80}\b(send|pay|purchase|buy|transfer)\b/i, "payment by wire, gift card or crypto"],
  [/\b(inheritance|next of kin|unclaimed (funds|fortune)|(\d+(\.\d+)?|ten|five) million (us )?(dollars|usd))\b/i, "inheritance or windfall offer"],
  [/\b(viagra|cialis|online casino|hot singles|adult dating)\b/i, "classic junk mail"],
];

/** Signs that the person (stars) or Gmail (Important) values this email: never spam. */
const KEEP_LABELS = new Set(["STARRED", "IMPORTANT"]);

/** Strong scam/phishing evidence in the email itself (empty when there is none). */
export function strongSpamSignals(input: SpamInput): string[] {
  const text = `${input.from}\n${input.subject}\n${input.body}`;
  return STRONG_SIGNALS.filter(([re]) => re.test(text)).map(([, reason]) => reason);
}

/**
 * Final call after the AI answered "DISCARDED: SPAM" for an email. Returns the reasons when it
 * really is possible spam, or an empty list to treat it as an ordinary email.
 */
export function confirmSpam(input: SpamInput): string[] {
  if (input.labels.some((l) => KEEP_LABELS.has(l))) return [];
  return strongSpamSignals(input);
}

/** "Jordan Taylor <jt@x.com>" → "Jordan Taylor"; a bare address stays as it is. */
export function senderName(from: string): string {
  const name = from.replace(/<[^>]*>/g, "").replace(/["']/g, "").trim();
  return name || from.replace(/[<>]/g, "").trim() || "an unknown sender";
}
