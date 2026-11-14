import { ApiError, errorResponse } from "@/lib/errors";
import { eleven, OUTPUT_FORMAT, TTS_MODEL, validVoiceId } from "@/lib/elevenlabs";
import { requireSignedIn } from "@/lib/server-auth";


/** POST { text, voiceId } → MP3 audio for exactly that text (called only for the email being played). */
export async function POST(req: Request) {
  try {
    await requireSignedIn(req);
    const body = (await req.json().catch(() => ({}))) as { text?: unknown; voiceId?: unknown };
    const voiceId = validVoiceId(body.voiceId);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new ApiError(400, "NO_TEXT", "There's no text to read.");
    if (text.length > 5000) throw new ApiError(413, "TEXT_TOO_LONG", "That text is too long to read in one go.");
    const res = await eleven(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: TTS_MODEL }),
    });
    const audio = await res.arrayBuffer();
    return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
