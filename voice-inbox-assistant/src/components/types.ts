export interface VoiceOption {
  voice_id: string;
  name: string;
  category?: string;
  description?: string;
  preview_url?: string | null;
  created_at_unix?: number | null;
  /** True when the signed-in person may delete it (their own voice, or any shared one for admins). */
  removable?: boolean;
  /** True when the signed-in person made it. */
  mine?: boolean;
}

export interface ActiveVoice {
  id: string;
  label: string;
}

export interface QueueItem {
  id: string;
  from: string;
  subject: string;
  category: "work" | "personal" | "transactions";
  group: "work" | "school" | "personal" | "transactions" | "spam" | "skipped";
  /** The summary with no lead-in or ordering words; the player adds them for the list being played. */
  body: string;
  /** Spoken text for the All tab (server-built); the player recomputes it per tab. */
  summary: string;
  /** "unsummarized": the AI couldn't summarize it (still listed). "possible-spam": set aside, not read. */
  note?: "unsummarized" | "possible-spam";
  reasons?: string[];
}

export const DEFAULT_VOICE: ActiveVoice = { id: "", label: "" };

export const SAMPLE_LINE = "Hi! This is how I'll sound reading your email summaries.";

/** Reads a JSON error body from our API, including the code for session expiry. */
export async function readError(res: Response): Promise<{ message: string; code: string }> {
  try {
    const json = (await res.json()) as { error?: string; code?: string };
    return { message: json.error ?? `Request failed (${res.status}).`, code: json.code ?? "" };
  } catch {
    return { message: `Request failed (${res.status}).`, code: "" };
  }
}

export function storageGet<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function storageSet(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: the choice just won't be remembered.
  }
}
