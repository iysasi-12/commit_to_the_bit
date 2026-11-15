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
  created_at_unix?: number | null;
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
      created_at_unix: v.created_at_unix ?? null,
    });
    // Voice slots and cloning access, so the UI can explain why a clone would fail.
    let slots: { used: number; limit: number; canClone: boolean } | null = null;
    try {
      const sub = (await (await eleven("/v1/user/subscription")).json()) as { voice_slots_used?: number; voice_limit?: number; can_use_instant_voice_cloning?: boolean };
      slots = { used: sub.voice_slots_used ?? 0, limit: sub.voice_limit ?? 0, canClone: Boolean(sub.can_use_instant_voice_cloning) };
    } catch {
      slots = null; // key may lack the user-read permission; cloning still works without this info
    }
    return NextResponse.json({
      slots,
      custom: voices.filter((v) => v.category !== "premade").map(simplify),
      presets: voices.filter((v) => v.category === "premade").map(simplify),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
