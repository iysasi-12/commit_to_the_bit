import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/errors";
import { eleven, validVoiceId } from "@/lib/elevenlabs";
import { requireSignedIn } from "@/lib/server-auth";

/** DELETE → removes one of your own (custom) voices from ElevenLabs, freeing a voice slot. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireSignedIn(req);
    const id = validVoiceId((await ctx.params).id);
    await eleven(`/v1/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
