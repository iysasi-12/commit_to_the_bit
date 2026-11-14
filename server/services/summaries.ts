import type { AppDeps } from "../context.ts";
import { sha256 } from "../crypto.ts";
import type { SummaryRow, UserRow } from "../db.ts";
import { AppError, Errors } from "../errors.ts";
import type { EmailForAi, InboxMessage } from "../providers/types.ts";
import { HOUR } from "../rateLimit.ts";
import { requireAi, requireConsent, type InboxService } from "./inbox.ts";

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Keeps whole sentences under the text-to-speech limit. */
export function capSpokenText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim();
}

export function summaryToApi(s: SummaryRow) {
  return {
    id: s.id,
    title: s.title,
    text: s.text,
    scope: s.scope,
    messageCount: s.message_count,
    truncatedCount: s.truncated_count,
    aiMode: s.ai_mode,
    createdAt: s.created_at,
  };
}

export class SummaryService {
  private readonly deps: AppDeps;
  private readonly inbox: InboxService;
  private readonly inflight = new Map<string, Promise<SummaryRow>>();

  constructor(deps: AppDeps, inbox: InboxService) {
    this.deps = deps;
    this.inbox = inbox;
  }

  private aiIdentity(): string {
    const ai = this.deps.providers.ai;
    if (!ai) return "none";
    return `${ai.mode}:${ai.name}:${ai.model}`;
  }

  async summarizeOne(user: UserRow, messageId: string): Promise<{ summary: SummaryRow; cached: boolean }> {
    requireConsent(user, this.deps);
    const settings = this.deps.store.getSettings(user);
    const key = sha256(JSON.stringify({ v: 1, scope: "one", messageId, length: settings.summaryLength, ai: this.aiIdentity(), name: user.name }));
    return this.cachedOrRun(user, key, async () => {
      const ai = requireAi(this.deps);
      const msg = await this.inbox.mailFor(user).getMessage(user.id, messageId, this.deps.config.limits.emailBodyChars);
      const email: EmailForAi = {
        id: msg.id,
        fromName: msg.fromName,
        fromEmail: msg.fromEmail,
        subject: msg.subject,
        date: msg.date,
        text: msg.bodyText || msg.snippet,
        truncated: msg.bodyTruncated,
      };
      const text = await ai.summarize({ emails: [email], scope: "one", scopeLabel: "this email", length: settings.summaryLength, listenerName: user.name });
      return {
        title: `Summary of "${msg.subject}"`,
        scope: "one",
        text,
        messageCount: 1,
        truncatedCount: msg.bodyTruncated ? 1 : 0,
      };
    });
  }

  async summarizeMany(user: UserRow, opts: { categoryId?: string | null }): Promise<{ summary: SummaryRow; cached: boolean }> {
    requireConsent(user, this.deps);
    const { store, config } = this.deps;
    const settings = store.getSettings(user);
    const count = Math.min(settings.summaryCount, config.limits.summaryMaxEmails);

    let label = `your latest ${count} emails`;
    let title = "Your latest emails";
    let pool: InboxMessage[];
    if (opts.categoryId) {
      const category = store.getCategory(user.id, opts.categoryId);
      if (!category) throw Errors.notFound("That category");
      await this.inbox.classify(user);
      const listing = await this.inbox.list(user);
      pool = listing.messages.filter((m) => m.categoryId === category.id);
      label = `your ${category.name} emails`;
      title = `Your ${category.name} emails`;
    } else {
      pool = (await this.inbox.fetchMessages(user)).messages;
    }
    const picked = pool.slice(0, count);
    if (picked.length === 0) {
      throw new AppError("NOTHING_TO_SUMMARIZE", 404, opts.categoryId ? "There are no emails in this category right now." : "Your inbox is empty right now.");
    }
    if (!opts.categoryId) label = `your latest ${picked.length} emails`;

    const key = sha256(
      JSON.stringify({
        v: 1,
        scope: "many",
        category: opts.categoryId ?? null,
        ids: picked.map((m) => `${m.id}:${m.internalDate}`),
        length: settings.summaryLength,
        ai: this.aiIdentity(),
        name: user.name,
      }),
    );
    return this.cachedOrRun(user, key, async () => {
      const ai = requireAi(this.deps);
      const mail = this.inbox.mailFor(user);
      const full = await mapLimit(picked, 4, (m) => mail.getMessage(user.id, m.id, config.limits.emailBodyChars));
      const emails: EmailForAi[] = full.map((m) => ({
        id: m.id,
        fromName: m.fromName,
        fromEmail: m.fromEmail,
        subject: m.subject,
        date: m.date,
        text: m.bodyText || m.snippet,
        truncated: m.bodyTruncated,
      }));
      const text = await ai.summarize({ emails, scope: "many", scopeLabel: label, length: settings.summaryLength, listenerName: user.name });
      return {
        title: `${title} (${picked.length})`,
        scope: opts.categoryId ? `category:${opts.categoryId}` : "inbox",
        text,
        messageCount: picked.length,
        truncatedCount: full.filter((m) => m.bodyTruncated).length,
      };
    });
  }

  private async cachedOrRun(
    user: UserRow,
    key: string,
    produce: () => Promise<{ title: string; scope: string; text: string; messageCount: number; truncatedCount: number }>,
  ): Promise<{ summary: SummaryRow; cached: boolean }> {
    const { store, limiter, config } = this.deps;
    const existing = store.getSummaryByKey(user.id, key);
    if (existing) return { summary: existing, cached: true };
    const flightKey = `${user.id}:${key}`;
    const running = this.inflight.get(flightKey);
    if (running) return { summary: await running, cached: true };

    const job = (async () => {
      limiter.consume(`summary:${user.id}`, config.rateLimits.summariesPerHour, HOUR, "summaries");
      const result = await produce();
      return store.insertSummary({
        user_id: user.id,
        cache_key: key,
        scope: result.scope,
        title: result.title,
        text: capSpokenText(result.text, config.limits.ttsMaxChars),
        message_count: result.messageCount,
        truncated_count: result.truncatedCount,
        ai_mode: this.deps.providers.ai ? (this.deps.providers.ai.mode === "demo" ? "demo" : this.deps.providers.ai.name) : "none",
        created_at: this.deps.now(),
      });
    })().finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, job);
    return { summary: await job, cached: false };
  }
}
