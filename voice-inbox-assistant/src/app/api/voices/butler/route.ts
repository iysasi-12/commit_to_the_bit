import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/errors";
import { eleven } from "@/lib/elevenlabs";
import { requireSignedIn } from "@/lib/server-auth";

export const maxDuration = 120;

const BUTLER_NAME = "The Butler";

// An original character voice (not modeled on any real actor).
const DESCRIPTION =
  "An elderly, distinguished English butler in his seventies with a warm, slightly gravelly, unhurried voice, crisp received pronunciation, and a gentle, dry wit.";
const PREVIEW_TEXT =
  "Starting with Work and School, sir. Your biology lab report is due Monday at 11:59 PM, sir, and Doctor Vance asks that you attach your raw data tables. I took the liberty of noting the deadline, sir.";

/** POST → returns The Butler voice, creating it once in the ElevenLabs account if needed. */
export async function POST(req: Request) {
  try {
    await requireSignedIn(req);
    const search = await eleven(`/v2/voices?page_size=100&search=${encodeURIComponent("Butler")}&include_total_count=false`);
    const found = ((await search.json()) as { voices?: Array<{ voice_id: string; name: string }> }).voices?.find((v) => v.name === BUTLER_NAME);
    if (found) return NextResponse.json({ voice_id: found.voice_id, name: BUTLER_NAME, created: false });

    const design = await eleven(`/v1/text-to-voice/design?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: DESCRIPTION, text: PREVIEW_TEXT, model_id: "eleven_ttv_v3" }),
    });
    const previews = ((await design.json()) as { previews?: Array<{ generated_voice_id: string }> }).previews ?? [];
    if (!previews[0]) throw new ApiError(502, "NO_PREVIEW", "ElevenLabs didn't return a voice for The Butler. Please try again.");
    const created = await eleven(`/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_name: BUTLER_NAME, voice_description: DESCRIPTION, generated_voice_id: previews[0].generated_voice_id }),
    });
    const json = (await created.json()) as { voice_id?: string };
    if (!json.voice_id) throw new ApiError(502, "NO_VOICE_ID", "ElevenLabs didn't return The Butler voice.");
    return NextResponse.json({ voice_id: json.voice_id, name: BUTLER_NAME, created: true });
  } catch (err) {
    return errorResponse(err);
  }
}
