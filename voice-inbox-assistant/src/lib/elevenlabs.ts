import "server-only";
import { ApiError } from "@/lib/errors";

export const ELEVEN_BASE = "https://api.elevenlabs.io";
// eleven_v4 is ElevenLabs' most lifelike, expressive model. Set ELEVENLABS_MODEL=eleven_flash_v2_5
// for faster, cheaper (but flatter) speech.
export const TTS_MODEL = process.env.ELEVENLABS_MODEL || "eleven_v4";
export const OUTPUT_FORMAT = "mp3_44100_128";

/**
 * Tuned for natural, conversational reading: a little lower stability lets intonation vary like
 * a person talking, high similarity keeps the voice's character, light style adds expression.
 */
export const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true };

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new ApiError(503, "ELEVENLABS_NOT_CONFIGURED", "ELEVENLABS_API_KEY is missing from .env.local on the server.");
  return key;
}

/** Reads ElevenLabs' error body ({detail:{status,message}} or a validation list) into a readable message. */
async function elevenError(res: Response): Promise<ApiError> {
  const text = await res.text();
  let status = "";
  let message = "";
  try {
    const json = JSON.parse(text) as { detail?: unknown };
    const d = json.detail;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      status = String((d as { status?: unknown }).status ?? "");
      message = String((d as { message?: unknown }).message ?? "");
    } else if (Array.isArray(d)) {
      message = d.map((x) => (x && typeof x === "object" ? String((x as { msg?: unknown }).msg ?? "") : String(x))).join("; ");
    } else if (typeof d === "string") {
      message = d;
    }
  } catch {
    message = text.slice(0, 300);
  }
  const s = status.toLowerCase();
  if (s === "invalid_api_key") return new ApiError(503, "ELEVENLABS_KEY", "ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY in .env.local.");
  if (s === "quota_exceeded") return new ApiError(402, "ELEVENLABS_QUOTA", `ElevenLabs is out of credits: ${message || "quota exceeded"}.`);
  if (s === "voice_not_found" || res.status === 404) return new ApiError(404, "VOICE_NOT_FOUND", "That ElevenLabs voice wasn't found. Pick another voice or check the voice ID.");
  if (s === "detected_captcha_voice" || message.toLowerCase().includes("requires verification")) {
    return new ApiError(
      403,
      "VOICE_NEEDS_VERIFICATION",
      "ElevenLabs needs you to verify this cloned voice before it can speak. Go to elevenlabs.io → Voices → My Voices, open the voice, and complete the short verification (read a sentence aloud). Then try again.",
    );
  }
  if (s === "missing_permissions") {
    const perm = message.match(/permission (\w+)/)?.[1] ?? "the needed permission";
    return new ApiError(403, "ELEVENLABS_PERMISSION", `Your ElevenLabs API key is missing the "${perm}" permission. In ElevenLabs go to Developers → API Keys, edit the key, and turn it on.`);
  }
  if (s.includes("voice_limit")) return new ApiError(409, "VOICE_LIMIT", `Your ElevenLabs voice slots are full: ${message || "delete a voice in ElevenLabs first"}.`);
  if (res.status === 429) return new ApiError(429, "ELEVENLABS_BUSY", "ElevenLabs is busy. Wait a few seconds and try again.");
  const readable = message || `HTTP ${res.status}`;
  return new ApiError(res.status >= 500 ? 502 : res.status, "ELEVENLABS_ERROR", `ElevenLabs: ${readable}`);
}

export async function eleven(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${ELEVEN_BASE}${path}`, { ...init, headers: { "xi-api-key": apiKey(), ...(init.headers as Record<string, string> | undefined) } });
  } catch {
    throw new ApiError(502, "ELEVENLABS_UNREACHABLE", "Couldn't reach ElevenLabs. Check the server's internet connection.");
  }
  if (!res.ok) throw await elevenError(res);
  return res;
}

export function validVoiceId(id: unknown): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{5,64}$/.test(id)) throw new ApiError(400, "BAD_VOICE_ID", "That doesn't look like an ElevenLabs voice ID.");
  return id;
}
