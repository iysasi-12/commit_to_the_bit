import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/errors";
import { eleven } from "@/lib/elevenlabs";
import { requireSignedIn } from "@/lib/server-auth";

export const maxDuration = 120;

/** POST { voiceDescription, text } → playable voice previews from ElevenLabs Voice Design. */
export async function POST(req: Request) {
  try {
    await requireSignedIn(req);
    const body = (await req.json().catch(() => ({}))) as { voiceDescription?: unknown; text?: unknown };
    const voiceDescription = typeof body.voiceDescription === "string" ? body.voiceDescription.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (voiceDescription.length < 20 || voiceDescription.length > 1000) {
      throw new ApiError(400, "BAD_DESCRIPTION", "Describe the voice in 20 to 1000 characters.");
    }
    if (text.length < 100 || text.length > 1000) throw new ApiError(400, "BAD_PREVIEW_TEXT", "Preview text must be 100 to 1000 characters.");
    const res = await eleven(`/v1/text-to-voice/design?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: voiceDescription, text, model_id: "eleven_ttv_v3" }),
    });
    const json = (await res.json()) as {
      previews?: Array<{ generated_voice_id: string; audio_base_64: string; media_type?: string; duration_secs?: number }>;
    };
    return NextResponse.json({
      previews: (json.previews ?? []).map((p) => ({
        generated_voice_id: p.generated_voice_id,
        audio_base_64: p.audio_base_64,
        media_type: p.media_type || "audio/mpeg",
        duration_secs: p.duration_secs ?? null,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
