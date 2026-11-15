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
      /\b(verification code|security code|one-?time (code|password|passcode)|otp|password reset|reset your password|2-?step|two-?factor|sign-?in code|login code|confirm your identity)\b/i,
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

const LABEL: Record<SensitiveKind, [string, string]> = {
  financial: ["banking or financial email", "banking or financial emails"],
  medical: ["medical or health email", "medical or health emails"],
  government: ["government or tax email", "government or tax emails"],
  security: ["security code or password email", "security code or password emails"],
};

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const say = (n: number) => NUMBER_WORDS[n] ?? String(n);

/** The spoken note at the end, e.g. "I skipped three sensitive emails: two banking or financial emails and one medical or health email..." */
export function sensitiveNotice(counts: Partial<Record<SensitiveKind, number>>): string | null {
  const parts = ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k) => `${say(counts[k]!)} ${LABEL[k][counts[k] === 1 ? 0 : 1]}`);
  const total = ORDER.reduce((n, k) => n + (counts[k] ?? 0), 0);
  if (total === 0) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `One more thing. I skipped ${say(total)} sensitive ${total === 1 ? "email" : "emails"}: ${list}. For your privacy, I didn't open, summarize, or read ${total === 1 ? "it" : "them"}. You can check ${total === 1 ? "it" : "them"} yourself in Gmail.`;
}
