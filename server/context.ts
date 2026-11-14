import type { AppConfig } from "./config.ts";
import type { Store } from "./db.ts";
import type { GoogleTokenService } from "./providers/google.ts";
import type { AiProvider, GoogleAuthProvider, MailProvider, VoiceProvider } from "./providers/types.ts";
import type { RateLimiter } from "./rateLimit.ts";
import type { FileStore } from "./storage.ts";

export const CONSENT_VERSION = "2026-11-14";

export interface Providers {
  /** null when Google OAuth isn't configured. */
  googleAuth: GoogleAuthProvider | null;
  /** Gmail for people who signed in with Google; null when not configured. */
  liveMail: MailProvider | null;
  /** Sample inbox for people who used "Try the demo". */
  demoMail: MailProvider;
  /** null = not configured and demo mode is off. */
  ai: AiProvider | null;
  voice: VoiceProvider | null;
}

export interface AppDeps {
  config: AppConfig;
  store: Store;
  files: FileStore;
  providers: Providers;
  tokens: GoogleTokenService | null;
  limiter: RateLimiter;
  now: () => number;
}
