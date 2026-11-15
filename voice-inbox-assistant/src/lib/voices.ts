import "server-only";
import { ApiError } from "@/lib/errors";
import { eleven } from "@/lib/elevenlabs";
import { accessFor, ownerOf, type Viewer } from "@/lib/voice-access";

export { accessFor, cleanDescription, isAdminEmail, ownerKey, ownerOf, tagDescription, type Viewer } from "@/lib/voice-access";

export interface AccountVoice {
  voice_id: string;
  name: string;
  category: string;
  description: string;
  preview_url: string | null;
  created_at_unix: number | null;
}

// The account's voice list is shared by every request, so it's cached briefly (it holds no
// per-user data until it is filtered by accessFor).
let cache: { at: number; voices: AccountVoice[] } | null = null;
const CACHE_MS = 60_000;

interface RawVoice {
  voice_id: string;
  name?: string;
  category?: string;
  description?: string | null;
  preview_url?: string | null;
  created_at_unix?: number | null;
}

export async function listAccountVoices(opts: { fresh?: boolean } = {}): Promise<AccountVoice[]> {
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.voices;
  const voices: AccountVoice[] = [];
  let token: string | null = null;
  // Page through the account's voices (100 per page, at most 5 pages).
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ page_size: "100", include_total_count: "false" });
    if (token) qs.set("next_page_token", token);
    const res = await eleven(`/v2/voices?${qs.toString()}`);
    const json = (await res.json()) as { voices?: RawVoice[]; has_more?: boolean; next_page_token?: string | null };
    for (const v of json.voices ?? []) {
      voices.push({
        voice_id: v.voice_id,
        name: v.name ?? "Voice",
        category: v.category ?? "",
        description: v.description ?? "",
        preview_url: v.preview_url ?? null,
        created_at_unix: v.created_at_unix ?? null,
      });
    }
    if (!json.has_more || !json.next_page_token) break;
    token = json.next_page_token;
  }
  cache = { at: Date.now(), voices };
  return voices;
}

export function forgetVoiceCache(): void {
  cache = null;
}

/**
 * Blocks speaking with a voice that belongs to someone else. Voice IDs that aren't in this
 * account (e.g. Voice Library IDs pasted by hand) are left for ElevenLabs to accept or refuse.
 */
export async function assertCanUseVoice(voiceId: string, me: Viewer): Promise<void> {
  let voice = (await listAccountVoices()).find((v) => v.voice_id === voiceId);
  // A voice made in the last minute may not be in the cached list yet.
  if (!voice) voice = (await listAccountVoices({ fresh: true })).find((v) => v.voice_id === voiceId);
  if (voice && !accessFor(voice, me).usable) {
    throw new ApiError(403, "VOICE_NOT_YOURS", "That voice belongs to another person, so it can't be used from your account. Pick one of your voices or a preset.");
  }
}

/** How many voices each person may keep (admins have no limit). Voice slots are shared by everyone. */
export function voicesPerUser(): number {
  const n = Number(process.env.VOICES_PER_USER ?? 3);
  return Number.isInteger(n) && n >= 0 ? n : 3;
}

export async function assertRoomForAnotherVoice(me: Viewer): Promise<void> {
  if (me.admin) return;
  const mine = (await listAccountVoices({ fresh: true })).filter((v) => ownerOf(v.description) === me.owner).length;
  const limit = voicesPerUser();
  if (mine >= limit) {
    throw new ApiError(409, "USER_VOICE_LIMIT", `You already have ${mine} saved ${mine === 1 ? "voice" : "voices"}, the most each person can keep (${limit}). Remove one of yours first.`);
  }
}
