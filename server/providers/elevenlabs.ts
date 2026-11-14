import { AppError, truncateDetail } from "../errors.ts";
import type { CloneFile, LibraryVoice, StockVoice, VoiceCapabilities, VoiceProvider } from "./types.ts";

type FetchFn = typeof fetch;

interface ElevenConfig {
  apiKey: string;
  modelId: string;
  outputFormat: string;
  baseUrl: string;
}

interface ProviderErrorBody {
  status: string;
  message: string;
}

function parseErrorBody(text: string): ProviderErrorBody {
  try {
    const json = JSON.parse(text) as { detail?: unknown };
    const detail = json.detail;
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const d = detail as { status?: unknown; message?: unknown };
      return { status: String(d.status ?? ""), message: String(d.message ?? "") };
    }
    if (Array.isArray(detail)) {
      const msgs = detail.map((d) => (d && typeof d === "object" ? String((d as { msg?: unknown }).msg ?? "") : String(d)));
      return { status: "validation_error", message: msgs.join("; ") };
    }
    if (typeof detail === "string") return { status: "", message: detail };
  } catch {
    // not JSON
  }
  return { status: "", message: text };
}

/**
 * Maps ElevenLabs failures to messages a person can act on.
 * Documented statuses: invalid_api_key (401), quota_exceeded, max_character_limit_exceeded (400), voice_not_found.
 */
export function mapElevenLabsError(httpStatus: number, bodyText: string, action: "speech" | "clone" | "voices" | "delete"): AppError {
  const { status, message } = parseErrorBody(bodyText);
  const s = status.toLowerCase();
  const detail = truncateDetail([status, message].filter(Boolean).join(": ") || `HTTP ${httpStatus}`);

  if (s === "invalid_api_key" || (httpStatus === 401 && !s)) {
    return new AppError("VOICE_CONFIG", 503, "The voice service rejected this server's ElevenLabs API key. The app owner should check ELEVENLABS_API_KEY.", { detail });
  }
  if (s === "quota_exceeded") {
    return new AppError("VOICE_QUOTA", 402, "The ElevenLabs account behind this app is out of credits for this month. The app owner can add credits or upgrade the plan, then try again.", { detail });
  }
  if (s === "max_character_limit_exceeded") {
    return new AppError("TEXT_TOO_LONG", 413, "This summary is too long to read aloud in one go. Try the brief summary length or fewer emails.", { detail });
  }
  if (s === "voice_not_found" || httpStatus === 404) {
    return new AppError("VOICE_NOT_FOUND", 409, "This voice no longer exists in the ElevenLabs account. Pick another voice on the Voice tab.", { detail });
  }
  if (s.includes("voice_limit") || s.includes("voice_slots")) {
    return new AppError("VOICE_SLOTS_FULL", 409, "The ElevenLabs account has no free voice slots. The app owner needs to delete unused voices or upgrade the plan.", { detail });
  }
  if (s === "detected_unusual_activity") {
    return new AppError("VOICE_BLOCKED", 403, "ElevenLabs paused free-tier use for this account because of unusual activity. The app owner needs a paid ElevenLabs plan.", { detail });
  }
  if (action === "clone" && (httpStatus === 402 || httpStatus === 403 || s.includes("subscription") || s.includes("clon") || s.includes("permission"))) {
    return new AppError(
      "VOICE_CLONE_UNAVAILABLE",
      402,
      "Voice cloning isn't available on the ElevenLabs plan behind this app. Instant Voice Cloning needs a paid plan; until then, pick a ready-made voice.",
      { detail },
    );
  }
  if (httpStatus === 403 || s === "missing_permissions") {
    return new AppError("VOICE_CONFIG", 503, "The ElevenLabs API key doesn't have permission for this. The app owner should enable the needed permissions on the key.", { detail });
  }
  if (httpStatus === 429) {
    return new AppError("VOICE_BUSY", 429, "The voice service is busy. Wait a few seconds and try again.", { retryable: true, detail });
  }
  if (httpStatus === 400 || httpStatus === 422) {
    if (action === "clone") {
      return new AppError(
        "VOICE_INVALID_AUDIO",
        422,
        "ElevenLabs couldn't use this recording. Upload clear speech (MP3, WAV, M4A, or WebM) that is at least 30 seconds long, then try again.",
        { detail },
      );
    }
    return new AppError("VOICE_ERROR", 502, "The voice service couldn't process this request.", { detail });
  }
  if (httpStatus >= 500) {
    return new AppError("VOICE_UNAVAILABLE", 502, "The voice service had a temporary problem. Please try again.", { retryable: true, detail });
  }
  return new AppError("VOICE_ERROR", 502, "The voice service returned an error. Please try again.", { detail });
}

const EXTENSIONS: Record<string, { mime: string; ext: string }> = {
  mp3: { mime: "audio/mpeg", ext: "mp3" },
  opus: { mime: "audio/ogg", ext: "ogg" },
  wav: { mime: "audio/wav", ext: "wav" },
  pcm: { mime: "audio/L16", ext: "pcm" },
};

/** ElevenLabs REST API, called directly with the xi-api-key header. */
export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly mode = "live" as const;
  private readonly cfg: ElevenConfig;
  private readonly fetchFn: FetchFn;
  private stockCache: { at: number; voices: StockVoice[] } | null = null;

  constructor(cfg: ElevenConfig, fetchFn: FetchFn = fetch) {
    this.cfg = cfg;
    this.fetchFn = fetchFn;
  }

  private async request(
    path: string,
    init: RequestInit & { action: "speech" | "clone" | "voices" | "delete" },
  ): Promise<Response> {
    const { action, ...rest } = init;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.baseUrl}${path}`, {
        ...rest,
        headers: { "xi-api-key": this.cfg.apiKey, ...(rest.headers as Record<string, string> | undefined) },
      });
    } catch (err) {
      throw new AppError("VOICE_UNAVAILABLE", 502, "Couldn't reach the voice service. Check the connection and try again.", { retryable: true, cause: err });
    }
    if (!res.ok) {
      throw mapElevenLabsError(res.status, await res.text(), action);
    }
    return res;
  }

  async listStockVoices(): Promise<StockVoice[]> {
    if (this.stockCache && Date.now() - this.stockCache.at < 10 * 60 * 1000) return this.stockCache.voices;
    const res = await this.request("/v2/voices?page_size=100&category=premade&include_total_count=false", { method: "GET", action: "voices" });
    const json = (await res.json()) as { voices?: Array<Record<string, unknown>> };
    // Only ElevenLabs' ready-made voices are offered to everyone. Clones made by other
    // people of this app live in the same ElevenLabs account and must never be listed here.
    const voices = (json.voices ?? [])
      .filter((v) => v.category === "premade")
      .map((v) => ({
        providerVoiceId: String(v.voice_id),
        name: String(v.name ?? "Voice"),
        description: String(v.description ?? ""),
        previewUrl: v.preview_url ? String(v.preview_url) : null,
        labels: (v.labels as Record<string, string> | undefined) ?? {},
      }));
    this.stockCache = { at: Date.now(), voices };
    return voices;
  }

  async searchLibrary(q: { search: string; page: number; pageSize: number }): Promise<{ voices: LibraryVoice[]; hasMore: boolean }> {
    const params = new URLSearchParams({ page_size: String(q.pageSize), page: String(q.page) });
    if (q.search) params.set("search", q.search);
    const res = await this.request(`/v1/shared-voices?${params.toString()}`, { method: "GET", action: "voices" });
    const json = (await res.json()) as { voices?: Array<Record<string, unknown>>; has_more?: boolean };
    const voices = (json.voices ?? []).map((v) => ({
      publicOwnerId: String(v.public_owner_id ?? ""),
      providerVoiceId: String(v.voice_id ?? ""),
      name: String(v.name ?? "Voice"),
      description: String(v.description ?? ""),
      previewUrl: v.preview_url ? String(v.preview_url) : null,
      category: String(v.category ?? ""),
      language: v.language ? String(v.language) : null,
      accent: v.accent ? String(v.accent) : null,
      gender: v.gender ? String(v.gender) : null,
      age: v.age ? String(v.age) : null,
      useCase: v.use_case ? String(v.use_case) : null,
    }));
    return { voices: voices.filter((v) => v.publicOwnerId && v.providerVoiceId), hasMore: Boolean(json.has_more) };
  }

  async addLibraryVoice(publicOwnerId: string, providerVoiceId: string, newName: string): Promise<string> {
    const res = await this.request(`/v1/voices/add/${encodeURIComponent(publicOwnerId)}/${encodeURIComponent(providerVoiceId)}`, {
      method: "POST",
      action: "voices",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: newName }),
    });
    const json = (await res.json()) as { voice_id?: string };
    if (!json.voice_id) throw new AppError("VOICE_ERROR", 502, "ElevenLabs didn't return the added voice.");
    return json.voice_id;
  }

  async capabilities(): Promise<VoiceCapabilities> {
    const res = await this.request("/v1/user/subscription", { method: "GET", action: "voices" });
    const json = (await res.json()) as { can_use_instant_voice_cloning?: boolean; character_count?: number; character_limit?: number };
    const limit = Number(json.character_limit ?? 0);
    const used = Number(json.character_count ?? 0);
    return {
      canClone: Boolean(json.can_use_instant_voice_cloning),
      quotaRemaining: limit > 0 ? Math.max(0, (limit - used) / limit) : null,
    };
  }

  async createClone(input: { name: string; description: string; files: CloneFile[]; removeBackgroundNoise: boolean }) {
    const form = new FormData();
    form.append("name", input.name);
    form.append("description", input.description);
    form.append("remove_background_noise", input.removeBackgroundNoise ? "true" : "false");
    for (const f of input.files) {
      form.append("files", new Blob([new Uint8Array(f.buffer)], { type: f.mime }), f.filename);
    }
    const res = await this.request("/v1/voices/add", { method: "POST", action: "clone", body: form });
    const json = (await res.json()) as { voice_id?: string; requires_verification?: boolean };
    if (!json.voice_id) throw new AppError("VOICE_ERROR", 502, "ElevenLabs didn't return the new voice.");
    return { providerVoiceId: json.voice_id, requiresVerification: Boolean(json.requires_verification) };
  }

  async deleteVoice(providerVoiceId: string): Promise<void> {
    try {
      await this.request(`/v1/voices/${encodeURIComponent(providerVoiceId)}`, { method: "DELETE", action: "delete" });
    } catch (err) {
      // Already gone at ElevenLabs: deletion achieved.
      if (err instanceof AppError && err.code === "VOICE_NOT_FOUND") return;
      throw err;
    }
  }

  async synthesize(input: { providerVoiceId: string; text: string; speed: number }) {
    const body: Record<string, unknown> = { text: input.text, model_id: this.cfg.modelId };
    // Only override voice settings when needed: a partial override would replace a cloned voice's tuned settings.
    if (Math.abs(input.speed - 1) > 0.001) body.voice_settings = { speed: input.speed };
    const res = await this.request(
      `/v1/text-to-speech/${encodeURIComponent(input.providerVoiceId)}?output_format=${encodeURIComponent(this.cfg.outputFormat)}`,
      {
        method: "POST",
        action: "speech",
        headers: { "Content-Type": "application/json", Accept: "audio/*" },
        body: JSON.stringify(body),
      },
    );
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length === 0) throw new AppError("VOICE_ERROR", 502, "The voice service returned empty audio. Please try again.", { retryable: true });
    const codec = this.cfg.outputFormat.split("_")[0] ?? "mp3";
    const fmt = EXTENSIONS[codec] ?? EXTENSIONS.mp3!;
    return { audio, mime: fmt.mime, extension: fmt.ext };
  }
}
