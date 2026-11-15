import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/errors";
import { eleven } from "@/lib/elevenlabs";
import { requireViewer } from "@/lib/server-auth";
import { assertRoomForAnotherVoice, forgetVoiceCache, tagDescription } from "@/lib/voices";

export const maxDuration = 120;

const MAX_BYTES = 10 * 1024 * 1024;
const MIN_BYTES = 20 * 1024;
// Uploads and in-browser recordings (Chrome records WebM, Safari records MP4/M4A).
const ALLOWED = ["mp3", "wav", "m4a", "mp4", "aac", "webm", "ogg", "oga", "flac"];

/**
 * POST multipart { name, consent="true", files[] } → creates a voice from the recording with
 * ElevenLabs Instant Voice Cloning (/v1/voices/add). Requires a paid ElevenLabs plan.
 */
export async function POST(req: Request) {
  try {
    const me = await requireViewer(req);
    const form = await req.formData().catch(() => null);
    if (!form) throw new ApiError(400, "BAD_FORM", "Add a recording and a voice name.");
    if (form.get("consent") !== "true") {
      throw new ApiError(400, "NO_CONSENT", "Confirm that this is your voice, or that you have the speaker's permission, before cloning.");
    }
    const name = String(form.get("name") ?? "").trim().slice(0, 100);
    if (!name) throw new ApiError(400, "NO_NAME", "Give the voice a name.");
    const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) throw new ApiError(400, "NO_FILE", "Record yourself or choose an audio file first.");
    let total = 0;
    for (const f of files) {
      const ext = f.name.toLowerCase().split(".").pop() ?? "";
      if (!ALLOWED.includes(ext) && !f.type.startsWith("audio/")) {
        throw new ApiError(415, "BAD_FILE_TYPE", `${f.name} isn't an audio file. Use MP3, WAV, M4A, WebM, OGG or FLAC.`);
      }
      if (f.size > MAX_BYTES) throw new ApiError(413, "FILE_TOO_LARGE", `${f.name} is over 10 MB. About 1 to 2 minutes of speech is enough.`);
      total += f.size;
    }
    if (total < MIN_BYTES) throw new ApiError(400, "TOO_SHORT", "That recording is too short. Record at least 30 seconds of clear speech (1 to 2 minutes is best).");
    await assertRoomForAnotherVoice(me);
    const upstream = new FormData();
    upstream.append("name", name);
    // The owner tag keeps this clone private to the person who made it.
    upstream.append("description", tagDescription("Created in Voice Inbox Assistant from the owner's own recording.", me.owner));
    upstream.append("remove_background_noise", form.get("removeNoise") === "true" ? "true" : "false");
    for (const f of files) upstream.append("files", f, f.name);
    const res = await eleven(`/v1/voices/add`, { method: "POST", body: upstream });
    const json = (await res.json()) as { voice_id?: string; requires_verification?: boolean };
    if (!json.voice_id) throw new ApiError(502, "NO_VOICE_ID", "ElevenLabs didn't return the new voice.");
    forgetVoiceCache();
    return NextResponse.json({ voice_id: json.voice_id, name, requires_verification: Boolean(json.requires_verification) });
  } catch (err) {
    return errorResponse(err);
  }
}
