import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/errors";
import { trashMessage, validGmailId } from "@/lib/gmail";
import { requireGoogleAccessToken } from "@/lib/server-auth";

/** POST → moves this email to Gmail's Trash. Only ever called when the person clicks Delete. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = validGmailId((await ctx.params).id);
    const accessToken = await requireGoogleAccessToken(req);
    await trashMessage(accessToken, id);
    return NextResponse.json({ ok: true, id, action: "trashed" });
  } catch (err) {
    return errorResponse(err);
  }
}
