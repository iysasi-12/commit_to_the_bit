import type { AppDeps } from "../context.ts";
import type { UserRow } from "../db.ts";
import type { InboxService } from "./inbox.ts";
import type { VoiceService } from "./voices.ts";

export class AccountService {
  private readonly deps: AppDeps;
  private readonly voices: VoiceService;
  private readonly inbox: InboxService;

  constructor(deps: AppDeps, voices: VoiceService, inbox: InboxService) {
    this.deps = deps;
    this.voices = voices;
    this.inbox = inbox;
  }

  /** Deletes generated summaries and audio kept by the app. */
  clearGenerated(user: UserRow): { audioFiles: number } {
    const audioFiles = this.voices.purgeAudio(user.id);
    this.deps.store.deleteSummaries(user.id);
    return { audioFiles };
  }

  /** Stops all AI processing and removes everything the AI produced for this person. */
  revokeConsent(user: UserRow): void {
    this.deps.store.setConsent(user.id, null, null);
    this.clearGenerated(user);
    this.deps.store.deleteClassifications(user.id);
  }

  /**
   * Deletes the account: voice clones at ElevenLabs, the Google grant, files, and all rows.
   * Returns what couldn't be confirmed so the UI can say so honestly.
   */
  async deleteAccount(user: UserRow): Promise<{ googleRevoked: boolean; voicesNotDeleted: string[] }> {
    const { store, files, providers, tokens } = this.deps;
    const voicesNotDeleted: string[] = [];
    for (const v of store.listVoices(user.id)) {
      if (!providers.voice) {
        if (v.kind === "own") voicesNotDeleted.push(v.name);
        continue;
      }
      const shared = v.kind === "library" && store.countVoicesUsingProviderId(v.provider_voice_id) > 1;
      if (shared) continue;
      try {
        await providers.voice.deleteVoice(v.provider_voice_id);
      } catch {
        if (v.kind === "own") voicesNotDeleted.push(v.name);
      }
    }
    let googleRevoked = Boolean(user.is_demo);
    if (tokens && !user.is_demo) {
      googleRevoked = (await tokens.revokeAndForget(user.id)).revokedAtGoogle;
    }
    files.removeUserFiles(user.id);
    store.deleteUser(user.id);
    this.inbox.forget(user.id);
    return { googleRevoked, voicesNotDeleted };
  }
}
