/** Pure helpers (no server or browser APIs) for turning per-email Gemini output into a spoken queue. */

export type Category = "work" | "personal" | "transactions";

export const CATEGORY_ORDER: Category[] = ["work", "personal", "transactions"];

export const CATEGORY_LABEL: Record<Category, string> = {
  work: "Work / School",
  personal: "Personal",
  transactions: "Transactions",
};

/** The prompt's lead-ins. Gemini writes one per email; the app removes it and speaks its own. */
export const LEAD_IN: Record<Category, string> = {
  work: "Starting with Work and School.",
  personal: "Next, Personal.",
  transactions: "Finally, Transactions.",
};

const LEAD_WORDS = String.raw`(?:and\s+)?(?:starting\s+(?:off\s+)?with|first(?:\s+up)?,?|next(?:\s+up)?,?|then,?|finally,?|lastly,?|last(?:\s+up)?,?|moving\s+on\s+to)`;
const CATEGORY_WORDS = String.raw`(?:the\s+)?(work\s*(?:and|&|\/)\s*school|work|school|personal|transactions?)`;
/** Persona asides that may follow a lead-in (", sir", ", listen up"). Anything else is kept as content. */
const VOCATIVE = String.raw`(?:sir|madam|my\s+(?:dear\s+)?(?:friend|lord|lady)|listen\s+up|people|rookie|champ|buddy|pal|kid|son|team|folks|everybody|everyone|if\s+you\s+please|as\s+always|right\s+then|let'?s\s+go|let'?s\s+get\s+to\s+it|let'?s\s+move)`;
/** What may follow the category in a lead-in: "emails", then persona asides after commas. */
const LEAD_TAIL = String.raw`(?:\s+(?:emails?|messages?|items?|stuff|section|category))?(?:\s*,\s*${VOCATIVE})*`;

/**
 * A whole lead-in sentence, persona variants included: "Starting with Work and School, sir.",
 * "FINALLY, TRANSACTIONS!", "Next, Personal emails.". The tail is short and must follow a comma,
 * so a real summary sentence ("Next, your work shift moved to Monday.") is never removed.
 */
const LEAD_IN_SENTENCE = new RegExp(String.raw`^\s*${LEAD_WORDS}\s*${CATEGORY_WORDS}\b${LEAD_TAIL}[.!?:]+\s*`, "i");
/** Just the lead-in phrase at the start of a longer sentence: "Starting with Work and School, for Biology 204...". */
const LEAD_IN_PHRASE = new RegExp(String.raw`^\s*${LEAD_WORDS}\s*${CATEGORY_WORDS}\b\s*[,;:.!-]+\s*`, "i");
/** A leftover ordering word, so the app's own "First," or "Finally," is never doubled. */
const LEADING_CONNECTOR = /^\s*(?:first|firstly|next|then|also|finally|lastly|and)\s*,\s*/i;

function categoryOf(word: string): Category {
  const w = word.toLowerCase();
  if (w.startsWith("personal")) return "personal";
  if (w.startsWith("transaction")) return "transactions";
  return "work";
}

function capitalize(text: string): string {
  return text.replace(/^(\W*)(\p{Ll})/u, (_, pre: string, ch: string) => pre + ch.toUpperCase());
}

/** Finer tab used in the UI: the prompt's Work/School category is split into Work and School. */
export type Group = "work" | "school" | "personal" | "transactions" | "skipped";

/** Spoken order of the sections (the sensitive-email notice always comes last). */
export const GROUP_ORDER: Group[] = ["work", "school", "personal", "transactions", "skipped"];

const SCHOOL_HINTS =
  /\.edu\b|canvas|blackboard|moodle|instructure|professor|\bprof\b|instructor|\bTA\b|teaching assistant|\bclass\b|course|lecture|assignment|homework|exam|quiz|midterm|syllabus|grade|lab report|semester|campus|university|college|school|student|tuition|registrar/i;

/** Splits Work/School into School (classes, professors, .edu, learning platforms) or Work. */
export function workOrSchool(from: string, subject: string, summary: string): "work" | "school" {
  return SCHOOL_HINTS.test(`${from} ${subject} ${summary}`) ? "school" : "work";
}

export interface QueueItem {
  id: string;
  from: string;
  subject: string;
  category: Category;
  group: Group;
  /** The email's summary with no lead-in or ordering words. */
  body: string;
  /** What is spoken when the whole queue (the All tab) is played: section intro + First/Finally + body. */
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

/** Removes Gemini's lead-ins (and any leading "First,"/"Finally,") so the app can add the right ones. */
export function stripLeadIns(text: string): { body: string; category: Category | null } {
  let body = text.trim();
  let category: Category | null = null;
  for (let i = 0; i < 3; i++) {
    const m = body.match(LEAD_IN_SENTENCE) ?? body.match(LEAD_IN_PHRASE);
    if (!m) break;
    category ??= categoryOf(m[1]!);
    body = body.slice(m[0].length).trim();
  }
  body = body.replace(LEADING_CONNECTOR, "");
  // A lead-in Gemini put in the middle (e.g. after a persona greeting) is removed too.
  body = body
    .replace(/(^|[.!?]\s+)(?:Starting with (Work and School)|Next, (Personal)|Finally, (Transactions))[.!?]\s*/gi, (_, pre: string, w?: string, p?: string, t?: string) => {
      category ??= categoryOf(w ?? p ?? t ?? "work");
      return pre;
    })
    .trim();
  return { body: capitalize(body), category };
}

/** Finds the category from Gemini's spoken lead-in, falling back to the email's wording. */
export function detectCategory(output: string): { category: Category; body: string; hadLeadIn: boolean } {
  const { body, category } = stripLeadIns(output);
  if (category) return { category, body, hadLeadIn: true };
  const lower = output.toLowerCase();
  const guess: Category = /\b(order|shipped|delivery|deliver|receipt|invoice|billed|payment|subscription|charged|refund)\b|\$\d/.test(lower)
    ? "transactions"
    : /\b(professor|class|course|assignment|homework|exam|quiz|grade|lab|canvas|meeting|shift|project|deadline|due)\b/.test(lower)
      ? "work"
      : "personal";
  return { category: guess, body, hadLeadIn: false };
}

// ---------------------------------------------------------------------------------------------
// Spoken order: a section intro, then "First," … "Finally," inside each section.
// ---------------------------------------------------------------------------------------------

const SECTION_NAME: Record<Exclude<Group, "skipped">, string> = { work: "Work", school: "School", personal: "Personal", transactions: "Transactions" };
const SECTION_NOUN: Record<Exclude<Group, "skipped">, string> = { work: "work", school: "school", personal: "personal", transactions: "transaction" };
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];
const say = (n: number) => NUMBER_WORDS[n] ?? String(n);
const emails = (n: number) => `${say(n)} ${n === 1 ? "email" : "emails"}`;

/** Words that read naturally in lower case after "First," (names and places keep their capital). */
const LOWERCASE_STARTERS = new Set(
  "a an the your you you've you're there this that these those it it's its we our for on in at by from with about after before just also some someone here heads quick good great today tomorrow tonight yesterday sir remember looks according".split(" "),
);

function joinMarker(marker: string, body: string): string {
  const first = body.match(/^[A-Za-z']+/)?.[0] ?? "";
  // Only Title-case words are lowered ("Your" → "your"); ALL-CAPS shouting and names stay as they are.
  const lower = first && /^[A-Z][a-z']*$/.test(first) && LOWERCASE_STARTERS.has(first.toLowerCase()) ? first.toLowerCase() + body.slice(first.length) : body;
  return `${marker}, ${lower}`;
}

function positionWord(i: number, n: number): string | null {
  if (n < 2) return null;
  if (i === 0) return "First";
  if (i === n - 1) return "Finally";
  return ORDINALS[i] ?? "Next";
}

/**
 * Builds the spoken text for exactly the list being played (All, or one tab), so the words match
 * the order heard: "Starting with Work, two emails. First, …" / "Finally, …" / "Next, School…" /
 * "Lastly, Transactions…". A single section gets "You have three work emails." instead.
 */
export function composeSpoken(items: ReadonlyArray<Pick<QueueItem, "group" | "body">>): string[] {
  const sections: Array<Exclude<Group, "skipped">> = [];
  const size = new Map<Group, number>();
  for (const it of items) {
    if (it.group === "skipped") continue;
    if (!size.has(it.group)) sections.push(it.group);
    size.set(it.group, (size.get(it.group) ?? 0) + 1);
  }
  const seen = new Map<Group, number>();
  return items.map((it) => {
    if (it.group === "skipped") return it.body;
    const group = it.group;
    const n = size.get(group)!;
    const i = seen.get(group) ?? 0;
    seen.set(group, i + 1);
    const marker = positionWord(i, n);
    const text = marker ? joinMarker(marker, it.body) : it.body;
    if (i > 0) return text;
    const s = sections.indexOf(group);
    let intro: string;
    if (sections.length === 1) intro = `You have ${emails(n).replace(/emails?$/, `${SECTION_NOUN[group]} $&`)}.`;
    else if (s === 0) intro = `Starting with ${SECTION_NAME[group]}, ${emails(n)}.`;
    else if (s === sections.length - 1) intro = `Lastly, ${SECTION_NAME[group]}, ${emails(n)}.`;
    else intro = `Next, ${SECTION_NAME[group]}, ${emails(n)}.`;
    return `${intro} ${text}`;
  });
}

/** Sets each item's `summary` to its spoken text for the full queue. */
export function withSpoken<T extends Pick<QueueItem, "group" | "body" | "summary">>(items: T[]): T[] {
  const spoken = composeSpoken(items);
  return items.map((it, i) => ({ ...it, summary: spoken[i]! }));
}

/**
 * Drops spam and orders emails Work → School → Personal → Transactions (keeping inbox order
 * within a section). Each item keeps its plain `body`; `summary` is the spoken All-tab text.
 */
export function buildQueue(results: Array<{ id: string; from: string; subject: string; output: string }>): QueueItem[] {
  const items: QueueItem[] = [];
  for (const r of results) {
    const text = cleanForSpeech(r.output);
    if (!text || isSpam(text)) continue;
    const { category, body } = detectCategory(text);
    if (!body || isSpam(body)) continue;
    const group: Group = category === "work" ? workOrSchool(r.from, r.subject, body) : category;
    items.push({ id: r.id, from: r.from, subject: r.subject, category, group, body, summary: body });
  }
  // Stable sort keeps inbox order inside each section.
  items.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return withSpoken(items);
}

/** Wraps one email for Gemini, matching the prompt's <email_data> format. */
export function wrapEmail(e: { from: string; sentDate: string; subject: string; body: string }): string {
  return `<email_data>\nFrom: ${e.from}\nSent Date: ${e.sentDate}\nSubject: ${e.subject}\nBody: ${e.body}\n</email_data>`;
}
