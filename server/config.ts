import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface Limits {
  /** Emails fetched for the inbox list. */
  inboxMax: number;
  /** Most emails one spoken summary may cover. */
  summaryMaxEmails: number;
  /** Characters of each email body sent to the AI (longer bodies are cut and flagged). */
  emailBodyChars: number;
  /** Hard cap on characters sent to text-to-speech in one request. */
  ttsMaxChars: number;
  maxCategories: number;
  categoryNameChars: number;
  categoryDescriptionChars: number;
  cloneMaxFiles: number;
  cloneMaxFileBytes: number;
  cloneMinTotalBytes: number;
}

export interface RateLimits {
  summariesPerHour: number;
  audioPerHour: number;
  classifyPerHour: number;
  clonesPerDay: number;
  libraryAddsPerDay: number;
  previewsPerHour: number;
  authPerMinute: number;
}

export interface AppConfig {
  port: number;
  publicUrl: string;
  dataDir: string;
  demoMode: boolean;
  secureCookies: boolean;
  /** Number of reverse proxies in front of the app (e.g. Caddy). 0 = none; use the socket address. */
  trustProxyHops: number;
  sessionSecret: string;
  cacheTtlHours: number;
  google: { clientId: string; clientSecret: string; redirectUri: string } | null;
  anthropic: { apiKey: string; model: string; refusalFallback: boolean } | null;
  elevenlabs: {
    apiKey: string;
    modelId: string;
    outputFormat: string;
    baseUrl: string;
    defaultVoiceId: string | null;
  } | null;
  limits: Limits;
  rateLimits: RateLimits;
}

export const DEFAULT_LIMITS: Limits = {
  inboxMax: 30,
  summaryMaxEmails: 15,
  emailBodyChars: 6000,
  ttsMaxChars: 2500,
  maxCategories: 12,
  categoryNameChars: 24,
  categoryDescriptionChars: 160,
  cloneMaxFiles: 5,
  cloneMaxFileBytes: 10 * 1024 * 1024,
  cloneMinTotalBytes: 20 * 1024,
};

export const DEFAULT_RATE_LIMITS: RateLimits = {
  summariesPerHour: 30,
  audioPerHour: 40,
  classifyPerHour: 40,
  clonesPerDay: 5,
  libraryAddsPerDay: 20,
  previewsPerHour: 20,
  authPerMinute: 30,
};

function str(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] ?? "").trim();
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const v = str(env, key).toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = Number.parseInt(str(env, key), 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Reads SESSION_SECRET, or creates and keeps a local one so dev restarts don't log everyone out. */
function resolveSessionSecret(env: NodeJS.ProcessEnv, dataDir: string): string {
  const fromEnv = str(env, "SESSION_SECRET");
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error("SESSION_SECRET must be at least 32 characters long.");
    }
    return fromEnv;
  }
  const file = path.join(dataDir, ".session-secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // fall through and create one
  }
  const created = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, created, { mode: 0o600 });
  console.warn(`[config] SESSION_SECRET not set; generated a local one in ${file}. Set SESSION_SECRET in production.`);
  return created;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const port = int(env, "PORT", 3000);
  const publicUrl = (str(env, "PUBLIC_URL") || `http://localhost:${port}`).replace(/\/+$/, "");
  const dataDir = path.resolve(str(env, "DATA_DIR") || "data");

  const googleId = str(env, "GOOGLE_CLIENT_ID");
  const googleSecret = str(env, "GOOGLE_CLIENT_SECRET");
  const anthropicKey = str(env, "ANTHROPIC_API_KEY");
  const elevenKey = str(env, "ELEVENLABS_API_KEY");

  const config: AppConfig = {
    port,
    publicUrl,
    dataDir,
    demoMode: bool(env, "DEMO_MODE", true),
    secureCookies: publicUrl.startsWith("https://"),
    trustProxyHops: int(env, "TRUST_PROXY", 0),
    sessionSecret: overrides.sessionSecret ?? resolveSessionSecret(env, dataDir),
    cacheTtlHours: int(env, "CACHE_TTL_HOURS", 72),
    google:
      googleId && googleSecret
        ? {
            clientId: googleId,
            clientSecret: googleSecret,
            redirectUri: str(env, "GOOGLE_REDIRECT_URI") || `${publicUrl}/auth/google/callback`,
          }
        : null,
    anthropic: anthropicKey
      ? {
          apiKey: anthropicKey,
          model: str(env, "ANTHROPIC_MODEL") || "claude-opus-5-5",
          refusalFallback: str(env, "ANTHROPIC_REFUSAL_FALLBACK").toLowerCase() !== "off",
        }
      : null,
    elevenlabs: elevenKey
      ? {
          apiKey: elevenKey,
          modelId: str(env, "ELEVENLABS_MODEL_ID") || "eleven_multilingual_v2",
          outputFormat: str(env, "ELEVENLABS_OUTPUT_FORMAT") || "mp3_44100_128",
          baseUrl: (str(env, "ELEVENLABS_BASE_URL") || "https://api.elevenlabs.io").replace(/\/+$/, ""),
          defaultVoiceId: str(env, "ELEVENLABS_DEFAULT_VOICE_ID") || null,
        }
      : null,
    limits: { ...DEFAULT_LIMITS },
    rateLimits: { ...DEFAULT_RATE_LIMITS },
  };
  return { ...config, ...overrides };
}
