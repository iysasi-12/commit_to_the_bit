import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/errors";
import { summarizeAll } from "@/lib/gemini";
import { fetchRecentEmails } from "@/lib/gmail";
import { sensitiveNotice } from "@/lib/sensitive";
import { requireGoogleAccessToken } from "@/lib/server-auth";
import { parseWindow } from "@/lib/time-window";
import { buildQueue, withSpoken, type QueueItem } from "@/lib/triage";

export const maxDuration = 120;

/**
 * POST { count } → reads the newest emails, skips sensitive ones without opening them,
 * summarizes the rest with Gemini, drops spam, and returns the ordered queue.
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
    const failed = results.filter((r) => r.output === null);
    if (scan.emails.length > 0 && failed.length === scan.emails.length) {
      throw new ApiError(503, "GEMINI_FAILED", failed[0]?.error ?? "Gemini couldn't summarize any emails. Please try again.");
    }
    const ok = results.filter((r): r is { email: (typeof r)["email"]; output: string } => r.output !== null);
    let queue: QueueItem[] = buildQueue(ok.map((r) => ({ id: r.email.id, from: r.email.from, subject: r.email.subject, output: r.output })));
    // The count of skipped sensitive emails is spoken last. It's written here, not by the AI.
    const notice = sensitiveNotice(scan.sensitive);
    if (notice) {
      queue.push({ id: "sensitive-notice", from: "Voice Inbox Assistant", subject: "Sensitive emails skipped", category: "transactions", group: "skipped", body: notice, summary: notice });
      queue = withSpoken(queue);
    }
    const sensitiveTotal = Object.values(scan.sensitive).reduce((n, v) => n + (v ?? 0), 0);
    return NextResponse.json({
      queue,
      stats: { fetched: scan.fetched, hours, spam: ok.length - (queue.length - (notice ? 1 : 0)), failed: failed.length, sensitive: sensitiveTotal, sensitiveByKind: scan.sensitive },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
