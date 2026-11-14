import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/errors";
import { eleven } from "@/lib/elevenlabs";
import { requireSignedIn } from "@/lib/server-auth";


interface RawVoice {
  voice_id: string;
  name?: string;
  category?: string;
  description?: string | null;
  preview_url?: string | null;
  labels?: Record<string, string>;
}

/** GET → the account's voices, split into saved custom voices and ElevenLabs presets. */
export async function GET(req: Request) {
  try {
    await requireSignedIn(req);
    const voices: RawVoice[] = [];
    let token: string | null = null;
    // Page through the account's voice list (100 per page, at most 5 pages).
    for (let page = 0; page < 5; page++) {
      const qs = new URLSearchParams({ page_size: "100", include_total_count: "false" });
      if (token) qs.set("next_page_token", token);
      const res = await eleven(`/v2/voices?${qs.toString()}`);
      const json = (await res.json()) as { voices?: RawVoice[]; has_more?: boolean; next_page_token?: string | null };
      voices.push(...(json.voices ?? []));
      if (!json.has_more || !json.next_page_token) break;
      token = json.next_page_token;
    }
    const simplify = (v: RawVoice) => ({
      voice_id: v.voice_id,
      name: v.name ?? "Voice",
      category: v.category ?? "",
      description: v.description ?? "",
      preview_url: v.preview_url ?? null,
      labels: v.labels ?? {},
    });
    return NextResponse.json({
      custom: voices.filter((v) => v.category !== "premade").map(simplify),
      presets: voices.filter((v) => v.category === "premade").map(simplify),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
