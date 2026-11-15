import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/errors";
import { eleven, validVoiceId } from "@/lib/elevenlabs";
import { requireViewer } from "@/lib/server-auth";
import { accessFor, forgetVoiceCache, listAccountVoices } from "@/lib/voices";

/** DELETE → removes one of YOUR saved voices from ElevenLabs, freeing a voice slot. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const me = await requireViewer(req);
    const id = validVoiceId((await ctx.params).id);
    const voice = (await listAccountVoices({ fresh: true })).find((v) => v.voice_id === id);
    if (!voice) throw new ApiError(404, "VOICE_NOT_FOUND", "That voice isn't in the account anymore.");
    if (!accessFor(voice, me).removable) throw new ApiError(403, "VOICE_NOT_YOURS", "You can only remove voices you made.");
    await eleven(`/v1/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
    forgetVoiceCache();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
