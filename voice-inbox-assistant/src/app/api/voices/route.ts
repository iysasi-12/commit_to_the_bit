import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/errors";
import { eleven } from "@/lib/elevenlabs";
import { requireViewer } from "@/lib/server-auth";
import { accessFor, cleanDescription, listAccountVoices, ownerOf, voicesPerUser, type AccountVoice } from "@/lib/voices";

/**
 * GET → the voices this person may use: ElevenLabs presets, the shared character voices, and
 * their own saved voices. Other people's voices are never returned.
 */
export async function GET(req: Request) {
  try {
    const me = await requireViewer(req);
    const voices = await listAccountVoices({ fresh: true });
    const view = (v: AccountVoice) => {
      const access = accessFor(v, me);
      return {
        voice_id: v.voice_id,
        name: v.name,
        category: v.category,
        description: cleanDescription(v.description),
        preview_url: v.preview_url,
        created_at_unix: v.created_at_unix,
        removable: access.removable,
        mine: access.mine,
      };
    };
    // Account-wide voice slots and cloning access, so the UI can explain why a clone would fail.
    let slots: { used: number; limit: number; canClone: boolean } | null = null;
    try {
      const sub = (await (await eleven("/v1/user/subscription")).json()) as { voice_slots_used?: number; voice_limit?: number; can_use_instant_voice_cloning?: boolean };
      slots = { used: sub.voice_slots_used ?? 0, limit: sub.voice_limit ?? 0, canClone: Boolean(sub.can_use_instant_voice_cloning) };
    } catch {
      slots = null; // key may lack the user-read permission; cloning still works without this info
    }
    return NextResponse.json({
      slots,
      mine: { used: voices.filter((v) => ownerOf(v.description) === me.owner).length, limit: me.admin ? null : voicesPerUser() },
      custom: voices.filter((v) => v.category !== "premade" && accessFor(v, me).visible).map(view),
      presets: voices.filter((v) => v.category === "premade").map(view),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
