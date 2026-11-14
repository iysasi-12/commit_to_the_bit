import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/errors";
import { eleven } from "@/lib/elevenlabs";
import { requireSignedIn } from "@/lib/server-auth";

export const maxDuration = 120;

const MAX_BYTES = 10 * 1024 * 1024;

/** POST multipart { name, files[] (.mp3/.wav) } → Instant Voice Clone via ElevenLabs /v1/voices/add. */
export async function POST(req: Request) {
  try {
    await requireSignedIn(req);
    const form = await req.formData().catch(() => null);
    if (!form) throw new ApiError(400, "BAD_FORM", "Upload a recording and a voice name.");
    const name = String(form.get("name") ?? "").trim().slice(0, 100);
    if (!name) throw new ApiError(400, "NO_NAME", "Give the voice a name.");
    const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) throw new ApiError(400, "NO_FILE", "Choose an .mp3 or .wav recording.");
    for (const f of files) {
      const ext = f.name.toLowerCase().split(".").pop();
      if (!["mp3", "wav"].includes(ext ?? "")) throw new ApiError(415, "BAD_FILE_TYPE", `${f.name} isn't an .mp3 or .wav file.`);
      if (f.size > MAX_BYTES) throw new ApiError(413, "FILE_TOO_LARGE", `${f.name} is over 10 MB. About 1 to 2 minutes of speech is enough.`);
    }
    const upstream = new FormData();
    upstream.append("name", name);
    upstream.append("remove_background_noise", "false");
    for (const f of files) upstream.append("files", f, f.name);
    const res = await eleven(`/v1/voices/add`, { method: "POST", body: upstream });
    const json = (await res.json()) as { voice_id?: string; requires_verification?: boolean };
    if (!json.voice_id) throw new ApiError(502, "NO_VOICE_ID", "ElevenLabs didn't return the new voice.");
    return NextResponse.json({ voice_id: json.voice_id, name, requires_verification: Boolean(json.requires_verification) });
  } catch (err) {
    return errorResponse(err);
  }
}
