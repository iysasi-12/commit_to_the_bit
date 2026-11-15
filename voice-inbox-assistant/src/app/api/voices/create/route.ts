import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/errors";
import { eleven } from "@/lib/elevenlabs";
import { requireViewer } from "@/lib/server-auth";
import { assertRoomForAnotherVoice, forgetVoiceCache, tagDescription } from "@/lib/voices";

/** POST { voiceName, voiceDescription, generatedVoiceId } → saves a designed voice as this person's own. */
export async function POST(req: Request) {
  try {
    const me = await requireViewer(req);
    const body = (await req.json().catch(() => ({}))) as { voiceName?: unknown; voiceDescription?: unknown; generatedVoiceId?: unknown };
    const voiceName = typeof body.voiceName === "string" ? body.voiceName.trim().slice(0, 100) : "";
    const voiceDescription = typeof body.voiceDescription === "string" ? body.voiceDescription.trim().slice(0, 1000) : "";
    const generatedVoiceId = typeof body.generatedVoiceId === "string" ? body.generatedVoiceId.trim() : "";
    if (!voiceName) throw new ApiError(400, "NO_NAME", "Give the voice a name.");
    if (voiceDescription.length < 20) throw new ApiError(400, "BAD_DESCRIPTION", "The voice description is missing.");
    if (!/^[A-Za-z0-9_-]{5,100}$/.test(generatedVoiceId)) throw new ApiError(400, "BAD_PREVIEW", "Pick one of the generated previews first.");
    await assertRoomForAnotherVoice(me);
    const res = await eleven(`/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_name: voiceName, voice_description: tagDescription(voiceDescription, me.owner), generated_voice_id: generatedVoiceId }),
    });
    const json = (await res.json()) as { voice_id?: string; name?: string };
    if (!json.voice_id) throw new ApiError(502, "NO_VOICE_ID", "ElevenLabs didn't return the new voice.");
    forgetVoiceCache();
    return NextResponse.json({ voice_id: json.voice_id, name: json.name ?? voiceName });
  } catch (err) {
    return errorResponse(err);
  }
}
