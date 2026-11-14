/**
 * Stand-ins used when DEMO_MODE=true and a service has no credentials.
 * They never call any outside service. The UI labels everything they produce as a demo.
 */
import { randomId } from "../crypto.ts";
import { AppError } from "../errors.ts";
import { truncateText } from "./gmailParse.ts";
import type {
  AiProvider,
  CategoryForAi,
  FullMessage,
  InboxMessage,
  LibraryVoice,
  MailProvider,
  StockVoice,
  SummaryRequest,
  VoiceCapabilities,
  VoiceProvider,
} from "./types.ts";

interface SampleEmail {
  id: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  hoursAgo: number;
  unread: boolean;
  body: string;
}

const SAMPLES: SampleEmail[] = [
  {
    id: "demo-01",
    fromName: "Ms. Rivera",
    fromEmail: "rivera@lincolnhigh.edu",
    subject: "Reminder: Biology lab report due Friday",
    hoursAgo: 1,
    unread: true,
    body: "Hi everyone,\n\nA reminder that your enzyme lab report is due this Friday at 11:59 PM on Canvas. Please include your data table and at least two graphs. The rubric is posted under Assignments.\n\nIf you were absent for the lab, see me during lunch on Wednesday.\n\nMs. Rivera",
  },
  {
    id: "demo-02",
    fromName: "Jordan Lee",
    fromEmail: "jordan@brightside.co",
    subject: "Can you cover Saturday's shift?",
    hoursAgo: 3,
    unread: true,
    body: "Hey,\n\nPriya needs Saturday off. Could you cover her shift from 10 AM to 4 PM? Let me know by Thursday so I can update the schedule.\n\nThanks,\nJordan",
  },
  {
    id: "demo-03",
    fromName: "Chase",
    fromEmail: "no-reply@alerts.chase.com",
    subject: "Your card payment of $48.20 is due Nov 20",
    hoursAgo: 5,
    unread: true,
    body: "Your minimum payment of $48.20 for the card ending in 4417 is due on November 20. Your statement balance is $312.65. Pay on time to avoid a late fee.",
  },
  {
    id: "demo-04",
    fromName: "Mom",
    fromEmail: "mom@example.com",
    subject: "Dinner Sunday?",
    hoursAgo: 6,
    unread: true,
    body: "Hi sweetie! Grandma is coming over Sunday. Dinner is at 6. Can you bring dessert? Love you.",
  },
  {
    id: "demo-05",
    fromName: "Amazon",
    fromEmail: "shipment-tracking@amazon.com",
    subject: "Delivered: Your package was left at the front door",
    hoursAgo: 8,
    unread: false,
    body: "Your package with Wireless Headphones was delivered today at 2:14 PM and left at the front door. Order total: $59.99.",
  },
  {
    id: "demo-06",
    fromName: "Coach Daniels",
    fromEmail: "daniels@lincolnhigh.edu",
    subject: "Practice moved to 4:30 tomorrow",
    hoursAgo: 10,
    unread: true,
    body: "Team, practice tomorrow is moved to 4:30 PM because the gym is being used for the assembly. Bring both jerseys.",
  },
  {
    id: "demo-07",
    fromName: "Nike",
    fromEmail: "news@nike.com",
    subject: "Up to 40% off. This weekend only.",
    hoursAgo: 12,
    unread: false,
    body: "Members get up to 40% off select styles this weekend. Free shipping on orders over $50. Unsubscribe anytime.",
  },
  {
    id: "demo-08",
    fromName: "Brightside Payroll",
    fromEmail: "payroll@brightside.co",
    subject: "Your pay stub for Nov 1 to Nov 14 is ready",
    hoursAgo: 20,
    unread: false,
    body: "Your pay stub for the period November 1 to November 14 is ready in the employee portal. Net pay: $412.37, deposited on November 15.",
  },
  {
    id: "demo-09",
    fromName: "Sam Carter",
    fromEmail: "sam.carter@example.com",
    subject: "Pictures from the game",
    hoursAgo: 26,
    unread: false,
    body: "Yo! Got some great pictures from Friday's game. Sending them over tonight. Are you going to Maya's birthday on Saturday?",
  },
  {
    id: "demo-10",
    fromName: "Spotify",
    fromEmail: "no-reply@spotify.com",
    subject: "Your receipt from Spotify",
    hoursAgo: 30,
    unread: false,
    body: "Thanks for your payment. Spotify Premium Student, $5.99, charged to Visa ending in 4417. Your next payment is on December 14.",
  },
  {
    id: "demo-11",
    fromName: "Canvas Notifications",
    fromEmail: "notifications@instructure.com",
    subject: "Grade posted: Algebra II Quiz 4",
    hoursAgo: 34,
    unread: false,
    body: "A grade has been posted for Algebra II Quiz 4. Score: 23 out of 25.",
  },
  {
    id: "demo-12",
    fromName: "Morning Brew",
    fromEmail: "crew@morningbrew.com",
    subject: "Your daily briefing",
    hoursAgo: 40,
    unread: false,
    body: "Good morning. Markets were mixed yesterday, a new phone launched, and a coffee chain changed its rewards program. Read the full newsletter on our site.",
  },
  {
    id: "demo-13",
    fromName: "Google",
    fromEmail: "no-reply@accounts.google.com",
    subject: "Security alert: new sign-in on Windows",
    hoursAgo: 50,
    unread: false,
    body: "Your Google Account was just signed in to from a new Windows device. If this was you, you don't need to do anything. If not, we'll help you secure your account.",
  },
  {
    id: "demo-14",
    fromName: "LinkedIn",
    fromEmail: "messages-noreply@linkedin.com",
    subject: "You appeared in 9 searches this week",
    hoursAgo: 60,
    unread: false,
    body: "See who's looking at your profile. Upgrade to Premium to see all 9 searches.",
  },
];

function toMessage(s: SampleEmail, now: number): InboxMessage {
  const internalDate = now - s.hoursAgo * 3600_000;
  return {
    id: s.id,
    threadId: s.id,
    fromName: s.fromName,
    fromEmail: s.fromEmail,
    subject: s.subject,
    date: new Date(internalDate).toISOString(),
    internalDate,
    snippet: s.body.replace(/\s+/g, " ").slice(0, 140),
    unread: s.unread,
  };
}

export class DemoMailProvider implements MailProvider {
  readonly mode = "demo" as const;
  // Fixed "now" per process keeps message dates stable so summary caching works in demos.
  private readonly now = Date.now();

  async listInbox(_userId: string, opts: { max: number; pageToken?: string }) {
    return { messages: SAMPLES.slice(0, opts.max).map((s) => toMessage(s, this.now)) };
  }

  async getMessage(_userId: string, id: string, bodyChars: number): Promise<FullMessage> {
    const s = SAMPLES.find((x) => x.id === id);
    if (!s) throw new AppError("NOT_FOUND", 404, "That email couldn't be found.");
    const { text, truncated } = truncateText(s.body, bodyChars);
    return { ...toMessage(s, this.now), bodyText: text, bodyTruncated: truncated };
  }
}

const DEFAULT_KEYWORDS: Record<string, string[]> = {
  school: ["school", "class", "teacher", "assignment", "homework", "grade", "quiz", "exam", "canvas", ".edu", "lab report", "practice", "coach", "course"],
  work: ["shift", "manager", "meeting", "payroll", "pay stub", "schedule", "client", "office", "project", "coworker"],
  transactions: ["receipt", "order", "payment", "due", "$", "delivered", "package", "invoice", "bank", "card", "statement", "charged"],
  personal: ["mom", "dad", "dinner", "family", "grandma", "pictures", "birthday", "love you", "yo!"],
  promotions: ["% off", "sale", "deal", "newsletter", "briefing", "unsubscribe", "searches", "upgrade to premium", "this weekend only"],
};

function keywordsFor(cat: CategoryForAi): string[] {
  const builtIn = DEFAULT_KEYWORDS[cat.name.toLowerCase()] ?? [];
  const fromText = `${cat.name} ${cat.description}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !["anything", "that", "with", "doesn", "another", "category", "from", "your", "fit"].includes(w));
  return [...new Set([...builtIn, ...fromText])];
}

export class DemoAiProvider implements AiProvider {
  readonly mode = "demo" as const;

  async classify(
    emails: Array<{ id: string; fromName: string; fromEmail: string; subject: string; snippet: string }>,
    categories: CategoryForAi[],
  ): Promise<Map<string, string>> {
    const fallback = categories[categories.length - 1]?.name ?? "Other";
    const out = new Map<string, string>();
    for (const e of emails) {
      const hay = `${e.fromName} ${e.fromEmail} ${e.subject} ${e.snippet}`.toLowerCase();
      let best = fallback;
      let bestScore = 0;
      for (const c of categories) {
        const score = keywordsFor(c).reduce((n, k) => n + (hay.includes(k) ? 1 : 0), 0);
        if (score > bestScore) {
          best = c.name;
          bestScore = score;
        }
      }
      out.set(e.id, best);
    }
    return out;
  }

  async summarize(req: SummaryRequest): Promise<string> {
    const intro = "This is a demo summary written without AI.";
    if (req.scope === "one") {
      const e = req.emails[0]!;
      const firstSentence = e.text.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
      return `${intro} ${e.fromName} wrote about "${e.subject}". ${firstSentence}`;
    }
    const lines = req.emails.slice(0, 8).map((e) => `From ${e.fromName}: ${e.subject}${/[.!?]$/.test(e.subject) ? "" : "."}`);
    const more = req.emails.length > 8 ? ` And ${req.emails.length - 8} more.` : "";
    return `${intro} Hi ${req.listenerName}, here's a quick look at ${req.scopeLabel}. ${lines.join(" ")}${more}`;
  }
}

/** A short chime per sentence so playback controls can be tried without a voice service. */
export function demoWav(text: string, speed = 1): Buffer {
  const sampleRate = 16000;
  const sentences = Math.min(30, Math.max(1, text.split(/[.!?]+/).filter((s) => s.trim()).length));
  const toneSec = 0.18 / speed;
  const gapSec = 0.24 / speed;
  const totalSamples = Math.ceil(sentences * (toneSec + gapSec) * sampleRate);
  const data = Buffer.alloc(totalSamples * 2);
  let offset = 0;
  for (let i = 0; i < sentences; i++) {
    const freq = 440 + 60 * (i % 5);
    const toneSamples = Math.floor(toneSec * sampleRate);
    for (let n = 0; n < toneSamples && offset < totalSamples; n++, offset++) {
      const env = Math.min(1, n / 200, (toneSamples - n) / 200);
      const v = Math.sin((2 * Math.PI * freq * n) / sampleRate) * 0.25 * env;
      data.writeInt16LE(Math.round(v * 32767), offset * 2);
    }
    offset += Math.floor(gapSec * sampleRate);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const DEMO_STOCK: StockVoice[] = [
  { providerVoiceId: "demo-warm", name: "Demo · Warm", description: "Placeholder voice for demo mode", previewUrl: null, labels: { tone: "warm" } },
  { providerVoiceId: "demo-bright", name: "Demo · Bright", description: "Placeholder voice for demo mode", previewUrl: null, labels: { tone: "bright" } },
  { providerVoiceId: "demo-calm", name: "Demo · Calm", description: "Placeholder voice for demo mode", previewUrl: null, labels: { tone: "calm" } },
];

const DEMO_LIBRARY: LibraryVoice[] = [
  ["lib-owner-1", "lib-narrator", "Demo Narrator", "Deep, steady narration", "en", "american", "male", "middle_aged", "narrative_story"],
  ["lib-owner-2", "lib-friendly", "Demo Friendly", "Upbeat and conversational", "en", "british", "female", "young", "conversational"],
  ["lib-owner-3", "lib-news", "Demo Newsreader", "Clear news delivery", "en", "american", "female", "middle_aged", "informative_educational"],
  ["lib-owner-4", "lib-grandpa", "Demo Storyteller", "Gentle older storyteller", "en", "australian", "male", "old", "narrative_story"],
].map(([publicOwnerId, providerVoiceId, name, description, language, accent, gender, age, useCase]) => ({
  publicOwnerId: publicOwnerId!,
  providerVoiceId: providerVoiceId!,
  name: name!,
  description: description!,
  previewUrl: null,
  category: "demo",
  language: language!,
  accent: accent!,
  gender: gender!,
  age: age!,
  useCase: useCase!,
}));

export class DemoVoiceProvider implements VoiceProvider {
  readonly mode = "demo" as const;

  async listStockVoices(): Promise<StockVoice[]> {
    return DEMO_STOCK;
  }

  async searchLibrary(q: { search: string; page: number; pageSize: number }) {
    const s = q.search.toLowerCase();
    const voices = DEMO_LIBRARY.filter((v) => !s || `${v.name} ${v.description} ${v.accent} ${v.gender}`.toLowerCase().includes(s));
    return { voices: voices.slice(q.page * q.pageSize, (q.page + 1) * q.pageSize), hasMore: (q.page + 1) * q.pageSize < voices.length };
  }

  async addLibraryVoice(_publicOwnerId: string, providerVoiceId: string): Promise<string> {
    return `demo-added-${providerVoiceId}`;
  }

  async capabilities(): Promise<VoiceCapabilities> {
    return { canClone: true, quotaRemaining: null };
  }

  async createClone() {
    await new Promise((r) => setTimeout(r, 400));
    return { providerVoiceId: `demo-clone-${randomId()}`, requiresVerification: false };
  }

  async deleteVoice(): Promise<void> {}

  async synthesize(input: { providerVoiceId: string; text: string; speed: number }) {
    return { audio: demoWav(input.text, input.speed), mime: "audio/wav", extension: "wav" };
  }
}
