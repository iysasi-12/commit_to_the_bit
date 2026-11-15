import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/errors";
import { moveMessage, validGmailId } from "@/lib/gmail";
import { requireGoogleAccessToken } from "@/lib/server-auth";

/**
 * POST { labelId } → files this email under that label and takes it out of the Inbox.
 * Only ever called when the person picks a destination under Reorganize.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = validGmailId((await ctx.params).id);
    const body = (await req.json().catch(() => ({}))) as { labelId?: unknown };
    const labelId = validGmailId(body.labelId, "label");
    const accessToken = await requireGoogleAccessToken(req);
    await moveMessage(accessToken, id, labelId);
    return NextResponse.json({ ok: true, id, action: "moved", labelId });
  } catch (err) {
    return errorResponse(err);
  }
}
