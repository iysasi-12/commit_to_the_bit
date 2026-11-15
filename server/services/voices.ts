import type { AppDeps } from "../context.ts";
import { randomId, sha256 } from "../crypto.ts";
import type { AudioRow, UserRow, VoiceRow } from "../db.ts";
import { AppError, Errors } from "../errors.ts";
import type { CloneFile, StockVoice, VoiceProvider } from "../providers/types.ts";
import { DAY, HOUR } from "../rateLimit.ts";

export const PREVIEW_TEXT = "Hi! This is my AI voice. From now on, I'll read your email summaries to you.";
const MAX_LIBRARY_VOICES = 5;

export interface ResolvedVoice {
  ref: string;
  providerVoiceId: string;
  name: string;
  kind: "stock" | "own" | "library";
}

export function requireVoice(deps: AppDeps): VoiceProvider {
  if (!deps.providers.voice) throw Errors.notConfigured("The voice service", "ELEVENLABS_API_KEY");
  return deps.providers.voice;
}

export function voiceRowToApi(v: VoiceRow) {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(v.meta_json) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return {
    id: v.id,
    ref: `voice:${v.id}`,
    kind: v.kind,
    name: v.name,
    status: v.status,
    createdAt: v.created_at,
    recordingKept: Boolean(v.recording_path),
    requiresVerification: Boolean(meta.requiresVerification),
    madeInDemo: v.provider_voice_id.startsWith("demo-"),
  };
}

export class VoiceService {
  private readonly deps: AppDeps;
  private readonly inflightAudio = new Map<string, Promise<AudioRow>>();

  constructor(deps: AppDeps) {
    this.deps = deps;
  }

  /** A voice made by the demo stand-in can't be used once real ElevenLabs keys are added. */
  isStaleDemoVoice(row: VoiceRow): boolean {
    return this.deps.providers.voice?.mode === "live" && row.provider_voice_id.startsWith("demo-");
  }

  async stockVoices(): Promise<StockVoice[]> {
    return requireVoice(this.deps).listStockVoices();
  }

  private async defaultVoice(): Promise<ResolvedVoice> {
    const configured = this.deps.providers.voice?.mode === "live" ? this.deps.config.elevenlabs?.defaultVoiceId : null;
    const stock = await this.stockVoices();
    const pick = (configured && stock.find((v) => v.providerVoiceId === configured)) || stock[0];
    if (!pick) {
      if (configured) return { ref: `stock:${configured}`, providerVoiceId: configured, name: "Default voice", kind: "stock" };
      throw new AppError("NO_VOICES", 409, "No voices are available in the ElevenLabs account. The app owner should check the account's voices.");
    }
    return { ref: `stock:${pick.providerVoiceId}`, providerVoiceId: pick.providerVoiceId, name: pick.name, kind: "stock" };
  }

  /**
   * The voice used to read this person's summaries. Only ElevenLabs' ready-made voices,
   * library voices this person added, or this person's own approved clone are allowed.
   */
  async resolve(user: UserRow): Promise<ResolvedVoice> {
    const ref = user.selected_voice_ref;
    if (!ref) return this.defaultVoice();
    if (ref.startsWith("stock:")) {
      const id = ref.slice("stock:".length);
      const stock = await this.stockVoices();
      const found = stock.find((v) => v.providerVoiceId === id);
      if (found) return { ref, providerVoiceId: id, name: found.name, kind: "stock" };
      this.deps.store.setSelectedVoice(user.id, null);
      return this.defaultVoice();
    }
    if (ref.startsWith("voice:")) {
      const row = this.deps.store.getVoice(user.id, ref.slice("voice:".length));
      if (row && row.status === "approved" && !this.isStaleDemoVoice(row)) return { ref, providerVoiceId: row.provider_voice_id, name: row.name, kind: row.kind };
      this.deps.store.setSelectedVoice(user.id, null);
      return this.defaultVoice();
    }
    this.deps.store.setSelectedVoice(user.id, null);
    return this.defaultVoice();
  }

  async select(user: UserRow, ref: string): Promise<ResolvedVoice> {
    if (ref.startsWith("stock:")) {
      const id = ref.slice("stock:".length);
      const stock = await this.stockVoices();
      const found = stock.find((v) => v.providerVoiceId === id);
      if (!found) throw new AppError("VOICE_NOT_ALLOWED", 403, "That voice isn't one of the available voices.");
      this.deps.store.setSelectedVoice(user.id, ref);
      return { ref, providerVoiceId: id, name: found.name, kind: "stock" };
    }
    if (ref.startsWith("voice:")) {
      const row = this.deps.store.getVoice(user.id, ref.slice("voice:".length));
      // Another person's voice looks exactly like a missing one: no hint that it exists.
      if (!row) throw Errors.notFound("That voice");
      if (this.isStaleDemoVoice(row)) {
        throw new AppError("DEMO_VOICE", 409, "This voice was made in demo mode, so it doesn't exist at ElevenLabs. Delete it and pick or create a real voice.");
      }
      if (row.status !== "approved") throw new AppError("VOICE_NOT_APPROVED", 409, "Listen to the preview and approve this voice before using it.");
      this.deps.store.setSelectedVoice(user.id, ref);
      return { ref, providerVoiceId: row.provider_voice_id, name: row.name, kind: row.kind };
    }
    throw Errors.validation("Unknown voice.");
  }

  // ---------- library ----------

  async searchLibrary(search: string, page: number) {
    const provider = requireVoice(this.deps);
    return provider.searchLibrary({ search: search.slice(0, 80), page: Math.max(0, Math.min(page, 50)), pageSize: 12 });
  }

  async addLibraryVoice(user: UserRow, input: { publicOwnerId: string; providerVoiceId: string; name: string }) {
    const { store, limiter, config } = this.deps;
    const provider = requireVoice(this.deps);
    const mine = store.listVoices(user.id).filter((v) => v.kind === "library");
    if (mine.length >= MAX_LIBRARY_VOICES) {
      throw new AppError("LIMIT_REACHED", 409, `You can keep up to ${MAX_LIBRARY_VOICES} library voices. Remove one first.`);
    }
    limiter.consume(`library:${user.id}`, config.rateLimits.libraryAddsPerDay, DAY, "adding library voices");
    const name = input.name.trim().slice(0, 60) || "Library voice";
    const providerVoiceId = await provider.addLibraryVoice(input.publicOwnerId, input.providerVoiceId, `${name} (VocaMail)`);
    const row = store.insertVoice({
      user_id: user.id,
      kind: "library",
      provider_voice_id: providerVoiceId,
      name,
      status: "approved",
      consent_at: null,
      recording_path: null,
      created_at: this.deps.now(),
      meta_json: JSON.stringify({ publicOwnerId: input.publicOwnerId, libraryVoiceId: input.providerVoiceId }),
    });
    store.setSelectedVoice(user.id, `voice:${row.id}`);
    return row;
  }

  // ---------- own voice (Instant Voice Clone) ----------

  async createClone(
    user: UserRow,
    input: { name: string; files: CloneFile[]; consentOwnVoice: boolean; consentProcessing: boolean; removeNoise: boolean; keepRecording: boolean },
  ): Promise<VoiceRow> {
    const { store, limiter, config, files: fileStore } = this.deps;
    if (!input.consentOwnVoice || !input.consentProcessing) {
      throw new AppError("CLONE_CONSENT_REQUIRED", 400, "Please confirm it's your own voice and that you agree to ElevenLabs processing your recording.");
    }
    if (input.files.length === 0) throw Errors.validation("Add a recording first.");
    const total = input.files.reduce((n, f) => n + f.buffer.length, 0);
    if (total < config.limits.cloneMinTotalBytes) {
      throw new AppError("RECORDING_TOO_SHORT", 422, "That recording is too short. Record at least 30 seconds of clear speech (1 to 2 minutes works best).");
    }
    const existing = store.listVoices(user.id).filter((v) => v.kind === "own");
    if (existing.length > 0) {
      throw new AppError("OWN_VOICE_EXISTS", 409, "You already have a voice of your own. Delete it in the Voice tab to record a new one.");
    }
    const provider = requireVoice(this.deps);
    const caps = await provider.capabilities();
    if (!caps.canClone) {
      throw new AppError(
        "VOICE_CLONE_UNAVAILABLE",
        402,
        "Voice cloning isn't available on the ElevenLabs plan behind this app. Instant Voice Cloning needs a paid plan; until then, pick a ready-made voice.",
      );
    }
    limiter.consume(`clone:${user.id}`, config.rateLimits.clonesPerDay, DAY, "creating voices");

    const name = input.name.trim().slice(0, 40) || `${user.name}'s voice`;
    const created = await provider.createClone({
      name: `${name} (VocaMail ${user.id.slice(0, 6)})`,
      description: "Personal voice created with consent in VocaMail. Used only to read this person's own email summaries.",
      files: input.files,
      removeBackgroundNoise: input.removeNoise,
    });
    const now = this.deps.now();
    const row = store.insertVoice({
      user_id: user.id,
      kind: "own",
      provider_voice_id: created.providerVoiceId,
      name,
      status: "preview",
      consent_at: now,
      recording_path: null,
      created_at: now,
      meta_json: JSON.stringify({ requiresVerification: created.requiresVerification }),
    });
    if (input.keepRecording) {
      const names = input.files.map((f, i) => {
        const ext = (f.filename.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
        const fileName = `${row.id}-${i}.${ext}`;
        fileStore.writeRecording(user.id, fileName, f.buffer);
        return fileName;
      });
      store.setVoiceRecordingPath(user.id, row.id, JSON.stringify(names));
    }
    // Otherwise the upload only ever lived in memory and is gone once this request ends.
    return store.getVoice(user.id, row.id)!;
  }

  async preview(user: UserRow, voiceId: string): Promise<{ audio: AudioRow; cached: boolean }> {
    const row = this.deps.store.getVoice(user.id, voiceId);
    if (!row) throw Errors.notFound("That voice");
    const voice: ResolvedVoice = { ref: `voice:${row.id}`, providerVoiceId: row.provider_voice_id, name: row.name, kind: row.kind };
    // Fixed sentence only: previews can never be used to make a voice say arbitrary text.
    return this.speak(user, { text: PREVIEW_TEXT, voice, summaryId: null, purpose: "preview" });
  }

  approve(user: UserRow, voiceId: string): VoiceRow {
    const row = this.deps.store.getVoice(user.id, voiceId);
    if (!row) throw Errors.notFound("That voice");
    this.deps.store.setVoiceStatus(user.id, voiceId, "approved");
    this.deps.store.setSelectedVoice(user.id, `voice:${voiceId}`);
    return this.deps.store.getVoice(user.id, voiceId)!;
  }

  deleteRecording(user: UserRow, voiceId: string): void {
    const row = this.deps.store.getVoice(user.id, voiceId);
    if (!row) throw Errors.notFound("That voice");
    this.removeRecordingFiles(user.id, row);
    this.deps.store.setVoiceRecordingPath(user.id, voiceId, null);
  }

  private removeRecordingFiles(userId: string, row: VoiceRow): void {
    if (!row.recording_path) return;
    let names: string[] = [];
    try {
      names = JSON.parse(row.recording_path) as string[];
    } catch {
      names = [];
    }
    for (const n of names) this.deps.files.remove(this.deps.files.recordingPath(userId, n));
  }

  /**
   * Deletes a voice. For a person's own clone this deletes it at ElevenLabs first,
   * then removes every cached audio file made with it and any kept recording.
   */
  async deleteVoice(user: UserRow, voiceId: string): Promise<{ deletedAtProvider: boolean }> {
    const { store } = this.deps;
    const row = store.getVoice(user.id, voiceId);
    if (!row) throw Errors.notFound("That voice");
    const provider = this.deps.providers.voice;
    let deletedAtProvider = false;
    if (row.kind === "own") {
      if (!provider) throw Errors.notConfigured("The voice service", "ELEVENLABS_API_KEY");
      try {
        await provider.deleteVoice(row.provider_voice_id);
        deletedAtProvider = true;
      } catch (err) {
        if (err instanceof AppError) {
          throw new AppError("VOICE_DELETE_FAILED", 502, `Couldn't delete your voice at ElevenLabs yet, so nothing was removed. ${err.message}`, {
            retryable: true,
            ...(err.detail ? { detail: err.detail } : {}),
          });
        }
        throw err;
      }
    } else if (provider && store.countVoicesUsingProviderId(row.provider_voice_id) <= 1) {
      try {
        await provider.deleteVoice(row.provider_voice_id);
        deletedAtProvider = true;
      } catch {
        deletedAtProvider = false;
      }
    }
    this.purgeAudio(user.id, { voiceRef: `voice:${row.id}` });
    this.removeRecordingFiles(user.id, row);
    store.deleteVoiceRow(user.id, row.id);
    const fresh = store.getUser(user.id);
    if (fresh?.selected_voice_ref === `voice:${row.id}`) store.setSelectedVoice(user.id, null);
    return { deletedAtProvider };
  }

  // ---------- speech ----------

  /** Generates speech once and serves the cached file on replays; concurrent duplicates share one request. */
  async speak(
    user: UserRow,
    input: { text: string; voice: ResolvedVoice; summaryId: string | null; purpose: "summary" | "preview" },
  ): Promise<{ audio: AudioRow; cached: boolean }> {
    const { store, files, config, limiter } = this.deps;
    const provider = requireVoice(this.deps);
    const settings = store.getSettings(store.getUser(user.id) ?? user);
    const speed = input.purpose === "preview" ? 1 : settings.speakingSpeed;
    if (input.text.length > config.limits.ttsMaxChars) {
      throw new AppError("TEXT_TOO_LONG", 413, `This text is longer than ${config.limits.ttsMaxChars} characters, the most that can be read aloud at once.`);
    }
    const key = sha256(
      JSON.stringify({
        v: 1,
        text: input.text,
        voice: input.voice.providerVoiceId,
        ref: input.voice.ref,
        mode: provider.mode,
        model: config.elevenlabs?.modelId ?? "demo",
        format: config.elevenlabs?.outputFormat ?? "wav",
        speed,
      }),
    );
    const existing = store.getAudioByKey(user.id, key);
    if (existing && files.exists(files.audioPath(user.id, existing.file_name))) return { audio: existing, cached: true };
    if (existing) store.deleteAudioRow(user.id, existing.id);

    const flightKey = `${user.id}:${key}`;
    const running = this.inflightAudio.get(flightKey);
    if (running) return { audio: await running, cached: true };

    const job = (async () => {
      if (input.purpose === "preview") {
        limiter.consume(`preview:${user.id}`, config.rateLimits.previewsPerHour, HOUR, "voice previews");
      } else {
        limiter.consume(`audio:${user.id}`, config.rateLimits.audioPerHour, HOUR, "generating audio");
      }
      const result = await provider.synthesize({ providerVoiceId: input.voice.providerVoiceId, text: input.text, speed });
      const id = randomId();
      const fileName = `${id}.${result.extension}`;
      files.writeAudio(user.id, fileName, result.audio);
      return store.insertAudio({
        id,
        user_id: user.id,
        cache_key: key,
        summary_id: input.summaryId,
        voice_ref: input.voice.ref,
        provider_voice_id: input.voice.providerVoiceId,
        file_name: fileName,
        mime: result.mime,
        bytes: result.audio.length,
        chars: input.text.length,
        voice_mode: provider.mode,
        created_at: this.deps.now(),
      });
    })().finally(() => this.inflightAudio.delete(flightKey));
    this.inflightAudio.set(flightKey, job);
    return { audio: await job, cached: false };
  }

  purgeAudio(userId: string, filter: { voiceRef?: string } = {}): number {
    const rows = this.deps.store.listAudio(userId, filter);
    for (const r of rows) {
      this.deps.files.remove(this.deps.files.audioPath(userId, r.file_name));
      this.deps.store.deleteAudioRow(userId, r.id);
    }
    return rows.length;
  }
}
