import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/errors";
import { summarizeAll } from "@/lib/gemini";
import { fetchRecentEmails } from "@/lib/gmail";
import { requireGoogleAccessToken } from "@/lib/server-auth";
import { buildQueue } from "@/lib/triage";

export const maxDuration = 120;

/** POST { count } → reads the newest emails, summarizes each with Gemini, drops spam, and returns the ordered queue. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { count?: unknown };
    const count = Number(body.count ?? 10);
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new ApiError(400, "BAD_COUNT", "Choose between 1 and 50 emails.");
    const accessToken = await requireGoogleAccessToken(req);
    const emails = await fetchRecentEmails(accessToken, count);
    const results = await summarizeAll(emails);
    const failed = results.filter((r) => r.output === null);
    if (emails.length > 0 && failed.length === emails.length) {
      throw new ApiError(503, "GEMINI_FAILED", failed[0]?.error ?? "Gemini couldn't summarize any emails. Please try again.");
    }
    const ok = results.filter((r): r is { email: (typeof r)["email"]; output: string } => r.output !== null);
    const queue = buildQueue(ok.map((r) => ({ id: r.email.id, from: r.email.from, subject: r.email.subject, output: r.output })));
    return NextResponse.json({
      queue,
      stats: { fetched: emails.length, spam: ok.length - queue.length, failed: failed.length },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
