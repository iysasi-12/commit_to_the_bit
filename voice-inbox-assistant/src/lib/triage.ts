/** Pure helpers (no server or browser APIs) for turning per-email Gemini output into a spoken queue. */

export type Category = "work" | "personal" | "transactions";

export const CATEGORY_ORDER: Category[] = ["work", "personal", "transactions"];

export const CATEGORY_LABEL: Record<Category, string> = {
  work: "Work / School",
  personal: "Personal",
  transactions: "Transactions",
};

export const LEAD_IN: Record<Category, string> = {
  work: "Starting with Work and School.",
  personal: "Next, Personal.",
  transactions: "Finally, Transactions.",
};

const LEAD_IN_PATTERNS: Array<[Category, RegExp]> = [
  ["work", /^\s*starting with work and school\.?\s*/i],
  ["personal", /^\s*next,?\s*personal\.?\s*/i],
  ["transactions", /^\s*finally,?\s*transactions?\.?\s*/i],
];

export interface QueueItem {
  id: string;
  from: string;
  subject: string;
  category: Category;
  /** Text spoken for this email (the first email of each category keeps its lead-in). */
  summary: string;
}

export function isSpam(output: string): boolean {
  return /^\W*DISCARDED:\s*SPAM\W*$/i.test(output.trim());
}

/** Removes any formatting the voice shouldn't read (the prompt forbids it, this is a safety net). */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/[*#|`_]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Finds the category from Gemini's spoken lead-in, falling back to the email's wording. */
export function detectCategory(output: string): { category: Category; body: string; hadLeadIn: boolean } {
  for (const [category, pattern] of LEAD_IN_PATTERNS) {
    if (pattern.test(output)) return { category, body: output.replace(pattern, "").trim(), hadLeadIn: true };
  }
  const lower = output.toLowerCase();
  const category: Category = /\b(order|shipped|delivery|deliver|receipt|invoice|billed|payment|subscription|charged|refund)\b|\$\d/.test(lower)
    ? "transactions"
    : /\b(professor|class|course|assignment|homework|exam|quiz|grade|lab|canvas|meeting|shift|project|deadline|due)\b/.test(lower)
      ? "work"
      : "personal";
  return { category, body: output.trim(), hadLeadIn: false };
}

/**
 * Drops spam, orders emails Work/School → Personal → Transactions (keeping inbox order within
 * a group), and keeps a spoken lead-in only on the first email of each group.
 */
export function buildQueue(results: Array<{ id: string; from: string; subject: string; output: string }>): QueueItem[] {
  const grouped: Record<Category, Array<Omit<QueueItem, "summary"> & { body: string }>> = { work: [], personal: [], transactions: [] };
  for (const r of results) {
    const text = cleanForSpeech(r.output);
    if (!text || isSpam(text)) continue;
    const { category, body } = detectCategory(text);
    if (!body) continue;
    grouped[category].push({ id: r.id, from: r.from, subject: r.subject, category, body });
  }
  const queue: QueueItem[] = [];
  for (const category of CATEGORY_ORDER) {
    grouped[category].forEach((item, i) => {
      queue.push({
        id: item.id,
        from: item.from,
        subject: item.subject,
        category,
        summary: i === 0 ? `${LEAD_IN[category]} ${item.body}` : item.body,
      });
    });
  }
  return queue;
}

/** Wraps one email for Gemini, matching the prompt's <email_data> format. */
export function wrapEmail(e: { from: string; sentDate: string; subject: string; body: string }): string {
  return `<email_data>\nFrom: ${e.from}\nSent Date: ${e.sentDate}\nSubject: ${e.subject}\nBody: ${e.body}\n</email_data>`;
}
