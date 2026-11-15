/**
 * Flags sensitive emails using ONLY the sender and subject line, so the email body is never
 * downloaded, sent to Gemini, or read aloud. Errs on the side of skipping.
 */

export type SensitiveKind = "financial" | "medical" | "government" | "security";

const RULES: Record<SensitiveKind, { senders: RegExp; subjects: RegExp }> = {
  financial: {
    senders:
      /\b(chase|bankofamerica|bank of america|bofa|wellsfargo|wells fargo|capitalone|capital one|citi(bank|cards)?|discover|americanexpress|american express|amex|usbank|u\.s\. bank|pnc|tdbank|td bank|ally|schwab|fidelity|vanguard|robinhood|sofi|chime|navyfederal|navy federal|creditkarma|credit karma|experian|equifax|transunion|credit union|federal credit|bank|banking)\b/i,
    subjects:
      /\b(bank statement|account statement|your statement|e-?statement|card statement|account alert|fraud|suspicious (activity|transaction)|direct deposit|available balance|account balance|low balance|wire transfer|routing number|account number|credit (score|report|limit)|loan|mortgage|overdraft|1099|w-?2|tax (return|document|form))\b/i,
  },
  medical: {
    senders:
      /\b(mychart|kaiser|patient portal|followmyhealth|athenahealth|labcorp|quest diagnostics|aetna|cigna|unitedhealthcare|united healthcare|blue ?cross|blue ?shield|humana|anthem|medicare|medicaid|hospital|clinic|medical|health system|healthcare|dental|dentist|pharmacy|cvs pharmacy|walgreens|teladoc|zocdoc|onemedical|one medical)\b/i,
    subjects:
      /\b(lab results?|test results?|your results|medical record|health record|diagnosis|prescription|refill|pharmacy|rx\b|appointment (reminder|confirmation)|visit summary|after visit|explanation of benefits|eob|claim (processed|update)|patient|doctor|physician|therapy|therapist|vaccine|immunization|telehealth|biopsy|imaging|x-?ray|mri)\b/i,
  },
  government: {
    senders: /\b(irs\.gov|ssa\.gov|social security|\.gov\b|dmv)\b/i,
    subjects: /\b(social security|ssn|tax refund|irs|jury duty|passport|driver'?s license|benefits notice)\b/i,
  },
  security: {
    senders: /^$/, // decided by subject only
    subjects:
      /\b(verification code|security code|one-?time (code|password|passcode)|otp|password reset|reset your password|2-?step|two-?factor|sign-?in code|login code|confirm your identity|security alert|new sign-?in|sign-?in attempt|login attempt|suspicious (sign-?in|login|activity)|account recovery|recovery code)\b/i,
  },
};

const ORDER: SensitiveKind[] = ["medical", "financial", "government", "security"];

/** Returns why an email is sensitive, or null if it's safe to summarize. */
export function sensitiveKind(from: string, subject: string): SensitiveKind | null {
  for (const kind of ORDER) {
    const rule = RULES[kind];
    if (rule.subjects.test(subject) || rule.senders.test(from)) return kind;
  }
  return null;
}

/** The two Gmail calls the scan needs. `headers` must fetch only sender and subject. */
export interface InboxSource<T> {
  listIds(count: number): Promise<string[]>;
  headers(id: string): Promise<{ id: string; from: string; subject: string }>;
  fullEmail(id: string): Promise<T>;
}

/**
 * Reads the newest emails, skipping sensitive ones: every email's sender and subject are read
 * first, and only emails that are NOT sensitive are downloaded in full. A sensitive email's body
 * is never requested, so it can't reach Gemini, the screen or the voice; only its kind is counted.
 */
export async function scanWithoutSensitive<T>(source: InboxSource<T>, count: number): Promise<{ emails: T[]; sensitive: Partial<Record<SensitiveKind, number>>; fetched: number }> {
  const ids = await source.listIds(count);
  const heads = await Promise.all(ids.map((id) => source.headers(id)));
  const sensitive: Partial<Record<SensitiveKind, number>> = {};
  const safeIds: string[] = [];
  for (const h of heads) {
    const kind = sensitiveKind(h.from, h.subject);
    if (kind) sensitive[kind] = (sensitive[kind] ?? 0) + 1;
    else safeIds.push(h.id);
  }
  const emails = await Promise.all(safeIds.map((id) => source.fullEmail(id)));
  return { emails, sensitive, fetched: ids.length };
}

const LABEL: Record<SensitiveKind, [string, string]> = {
  financial: ["banking or financial email", "banking or financial emails"],
  medical: ["medical or health email", "medical or health emails"],
  government: ["government or tax email", "government or tax emails"],
  security: ["security code or password email", "security code or password emails"],
};

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const say = (n: number) => NUMBER_WORDS[n] ?? String(n);

/** The spoken note at the end, e.g. "I skipped three sensitive emails: two banking or financial emails and one medical or health email..." */
export function sensitiveNotice(counts: Partial<Record<SensitiveKind, number>>): string | null {
  const parts = ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k) => `${say(counts[k]!)} ${LABEL[k][counts[k] === 1 ? 0 : 1]}`);
  const total = ORDER.reduce((n, k) => n + (counts[k] ?? 0), 0);
  if (total === 0) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `One more thing. I skipped ${say(total)} sensitive ${total === 1 ? "email" : "emails"}: ${list}. For your privacy, I didn't open, summarize, or read ${total === 1 ? "it" : "them"}. You can check ${total === 1 ? "it" : "them"} yourself in Gmail.`;
}
