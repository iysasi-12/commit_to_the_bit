import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/errors";
import { summarizeAll, summarizeEmail } from "@/lib/gemini";
import { fetchRecentEmails, type ParsedEmail } from "@/lib/gmail";
import { sensitiveNotice } from "@/lib/sensitive";
import { requireGoogleAccessToken } from "@/lib/server-auth";
import { confirmSpam } from "@/lib/spam";
import { parseWindow } from "@/lib/time-window";
import { buildQueue, isSpam, withSpoken, type QueueItem, type SummaryResult } from "@/lib/triage";

export const maxDuration = 120;

/**
 * POST { count, hours?, length?, persona? } → reads the inbox (read-only here), skips sensitive
 * emails without opening them, summarizes the rest with Gemini, and returns the ordered queue.
 * Nothing is dropped or changed in Gmail: failed summaries are listed as "couldn't summarize",
 * and an email is set aside as possible spam only with strong evidence (src/lib/spam.ts).
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { count?: unknown; persona?: unknown; length?: unknown; hours?: unknown };
    const persona = body.persona === "butler" || body.persona === "coach" ? body.persona : "standard";
    const length = body.length === "short" || body.length === "long" ? body.length : "medium";
    const count = Number(body.count ?? 10);
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new ApiError(400, "BAD_COUNT", "Choose between 1 and 50 emails.");
    // Optional time window: 8, 16 or 48 hours; anything else means "newest emails, any time".
    const hours = parseWindow(body.hours);
    const accessToken = await requireGoogleAccessToken(req);
    const scan = await fetchRecentEmails(accessToken, count, hours);
    const results = await summarizeAll(scan.emails, { persona, length });

    // Second opinion on every "spam" answer: keep it aside only with strong evidence; otherwise
    // ask again with "this is not spam" so the email is summarized like any other.
    let secondPasses = 0;
    const resolved: SummaryResult[] = await Promise.all(
      results.map(async (r): Promise<SummaryResult> => {
        const base = { id: r.email.id, from: r.email.from, subject: r.email.subject };
        if (r.output === null || !isSpam(r.output)) return { ...base, output: r.output };
        const reasons = confirmSpam(r.email as ParsedEmail);
        if (reasons.length) return { ...base, output: r.output, spamReasons: reasons };
        secondPasses++;
        try {
          return { ...base, output: await summarizeEmail(r.email, { persona, length, notSpam: true }) };
        } catch {
          return { ...base, output: null };
        }
      }),
    );

    let queue: QueueItem[] = buildQueue(resolved);
    // The count of skipped sensitive emails is spoken last. It's written here, not by the AI.
    const notice = sensitiveNotice(scan.sensitive);
    if (notice) {
      queue.push({ id: "sensitive-notice", from: "Voice Inbox Assistant", subject: "Sensitive emails skipped", category: "transactions", group: "skipped", body: notice, summary: notice });
      queue = withSpoken(queue);
    }
    const sensitiveTotal = Object.values(scan.sensitive).reduce((n, v) => n + (v ?? 0), 0);
    const failed = queue.filter((q) => q.note === "unsummarized").length;
    // If Gemini failed for every email, say why (quota, key...), but still list the emails.
    const aiError = scan.emails.length > 0 && results.every((r) => r.output === null) ? (results[0]?.error ?? "Gemini couldn't summarize any emails.") : null;
    return NextResponse.json({
      queue,
      stats: {
        fetched: scan.fetched,
        hours,
        spam: queue.filter((q) => q.group === "spam").length,
        recheckedNotSpam: secondPasses,
        failed,
        aiError,
        sensitive: sensitiveTotal,
        sensitiveByKind: scan.sensitive,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
