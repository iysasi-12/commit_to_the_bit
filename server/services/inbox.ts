import { CONSENT_VERSION, type AppDeps } from "../context.ts";
import type { CategoryRow, UserRow } from "../db.ts";
import { AppError, Errors } from "../errors.ts";
import type { AiProvider, InboxMessage, MailProvider } from "../providers/types.ts";
import { HOUR } from "../rateLimit.ts";

export interface InboxItem extends InboxMessage {
  categoryId: string | null;
}

const LIST_CACHE_MS = 60_000;
const CLASSIFY_BATCH = 25;

export function requireConsent(user: UserRow): void {
  if (!user.ai_consent_at || user.ai_consent_version !== CONSENT_VERSION) throw Errors.consentRequired();
}

export function requireAi(deps: AppDeps): AiProvider {
  if (!deps.providers.ai) throw Errors.notConfigured("The AI summary service", "ANTHROPIC_API_KEY");
  return deps.providers.ai;
}

export class InboxService {
  private readonly deps: AppDeps;
  private readonly listCache = new Map<string, { at: number; messages: InboxMessage[]; nextPageToken?: string }>();
  private readonly classifying = new Map<string, Promise<number>>();

  constructor(deps: AppDeps) {
    this.deps = deps;
  }

  mailFor(user: UserRow): MailProvider {
    if (user.is_demo) return this.deps.providers.demoMail;
    if (!this.deps.providers.liveMail) throw Errors.notConfigured("Gmail", "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
    return this.deps.providers.liveMail;
  }

  /** Lists the newest inbox messages. A short cache avoids re-reading Gmail for back-to-back requests. */
  async fetchMessages(user: UserRow, opts: { refresh?: boolean } = {}): Promise<{ messages: InboxMessage[]; nextPageToken?: string }> {
    const now = this.deps.now();
    const cached = this.listCache.get(user.id);
    if (!opts.refresh && cached && now - cached.at < LIST_CACHE_MS) return cached;
    const result = await this.mailFor(user).listInbox(user.id, { max: this.deps.config.limits.inboxMax });
    const sorted = [...result.messages].sort((a, b) => b.internalDate - a.internalDate);
    const entry = { at: now, messages: sorted, ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}) };
    this.listCache.set(user.id, entry);
    return entry;
  }

  forget(userId: string): void {
    this.listCache.delete(userId);
  }

  async list(user: UserRow, opts: { refresh?: boolean } = {}) {
    const { messages } = await this.fetchMessages(user, opts);
    const fresh = this.deps.store.getUser(user.id) ?? user;
    const assigned = this.deps.store.getClassifications(user.id, fresh.categories_version);
    const items: InboxItem[] = messages.map((m) => ({ ...m, categoryId: assigned.get(m.id) ?? null }));
    return {
      messages: items,
      unclassified: items.filter((m) => !m.categoryId).length,
      categoriesVersion: fresh.categories_version,
    };
  }

  /**
   * Sorts any not-yet-sorted inbox messages into the person's categories.
   * Only sender, subject and the short Gmail preview are sent to the AI for this.
   */
  async classify(user: UserRow): Promise<{ assigned: number }> {
    requireConsent(user);
    const running = this.classifying.get(user.id);
    if (running) return { assigned: await running };
    const job = this.runClassify(user).finally(() => this.classifying.delete(user.id));
    this.classifying.set(user.id, job);
    return { assigned: await job };
  }

  private async runClassify(user: UserRow): Promise<number> {
    const { store, limiter, config } = this.deps;
    const fresh = store.getUser(user.id) ?? user;
    const version = fresh.categories_version;
    const { messages } = await this.fetchMessages(fresh);
    const assigned = store.getClassifications(user.id, version);
    const todo = messages.filter((m) => !assigned.has(m.id));
    if (todo.length === 0) return 0;

    const ai = requireAi(this.deps);
    limiter.consume(`classify:${user.id}`, config.rateLimits.classifyPerHour, HOUR, "sorting emails");

    const categories = store.listCategories(user.id);
    const byName = new Map(categories.map((c) => [c.name, c]));
    const fallback = categories.find((c) => c.is_fallback) ?? categories[categories.length - 1];
    if (!fallback) throw new AppError("NO_CATEGORIES", 409, "Add at least one category first.");
    const forAi = orderForAi(categories).map((c) => ({ name: c.name, description: c.description }));

    let count = 0;
    for (let i = 0; i < todo.length; i += CLASSIFY_BATCH) {
      const batch = todo.slice(i, i + CLASSIFY_BATCH);
      const result = await ai.classify(
        batch.map((m) => ({ id: m.id, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject, snippet: m.snippet })),
        forAi,
      );
      const entries: Array<[string, string]> = batch.map((m) => {
        const cat = byName.get(result.get(m.id) ?? "") ?? fallback;
        return [m.id, cat.id];
      });
      // Categories may have changed while the AI was working; don't save stale results.
      if ((store.getUser(user.id)?.categories_version ?? -1) !== version) break;
      store.saveClassifications(user.id, version, entries, this.deps.now());
      count += entries.length;
    }
    return count;
  }
}

/** Fallback category last so the AI reads the specific ones first. */
function orderForAi(categories: CategoryRow[]): CategoryRow[] {
  return [...categories].sort((a, b) => a.is_fallback - b.is_fallback || a.position - b.position);
}
