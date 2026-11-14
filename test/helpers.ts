/**
 * Test harness: real Express app + real SQLite + real file storage, with MOCK
 * providers for Google, Gmail, Anthropic and ElevenLabs. Nothing here calls a
 * live service; passing tests are not evidence that the live APIs work.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, type AppServices } from "../server/app.ts";
import { loadConfig, type AppConfig } from "../server/config.ts";
import type { AppDeps, Providers } from "../server/context.ts";
import { TokenCipher } from "../server/crypto.ts";
import { Store } from "../server/db.ts";
import { AppError } from "../server/errors.ts";
import { DemoMailProvider } from "../server/providers/demo.ts";
import { GoogleTokenService } from "../server/providers/google.ts";
import type {
  AiProvider,
  CategoryForAi,
  CloneFile,
  FullMessage,
  GoogleAuthProvider,
  GoogleIdentity,
  InboxMessage,
  MailProvider,
  StockVoice,
  SummaryRequest,
  VoiceProvider,
} from "../server/providers/types.ts";
import { RateLimiter } from "../server/rateLimit.ts";
import { FileStore } from "../server/storage.ts";

export const GMAIL_SCOPE = "openid email profile https://www.googleapis.com/auth/gmail.readonly";

export function sampleMessages(prefix: string): Array<InboxMessage & { body: string }> {
  const base = Date.UTC(2026, 10, 14, 12);
  const rows: Array<[string, string, string, string]> = [
    ["Ms. Rivera", "rivera@school.edu", "Lab report due Friday", "Your biology lab report is due Friday at 11:59 PM."],
    ["Jordan Lee", "jordan@work.co", "Cover Saturday shift?", "Can you cover Saturday 10 to 4? Reply by Thursday."],
    ["Chase", "alerts@chase.com", "Payment of $48.20 due Nov 20", "Minimum payment $48.20 due November 20."],
    ["Mom", "mom@example.com", "Dinner Sunday?", "Dinner at 6 on Sunday. Bring dessert."],
    ["Nike", "news@nike.com", "40% off this weekend", "Sale this weekend only. Unsubscribe anytime."],
  ];
  return rows.map(([fromName, fromEmail, subject, body], i) => ({
    id: `${prefix}${i + 1}`,
    threadId: `${prefix}t${i + 1}`,
    fromName,
    fromEmail,
    subject,
    date: new Date(base - i * 3600_000).toISOString(),
    internalDate: base - i * 3600_000,
    snippet: body.slice(0, 60),
    unread: i < 2,
    body,
  }));
}

/** Gmail stand-in keyed by app user id, so two people get different inboxes. */
export class FakeMail implements MailProvider {
  readonly mode = "live" as const;
  inboxes = new Map<string, Array<InboxMessage & { body: string }>>();
  listCalls = 0;
  getCalls = 0;
  failWith: AppError | null = null;

  setInbox(userId: string, messages: Array<InboxMessage & { body: string }>) {
    this.inboxes.set(userId, messages);
  }

  async listInbox(userId: string, opts: { max: number }) {
    this.listCalls++;
    if (this.failWith) throw this.failWith;
    const msgs = this.inboxes.get(userId) ?? [];
    return { messages: msgs.slice(0, opts.max).map(({ body: _b, ...m }) => m) };
  }

  async getMessage(userId: string, id: string, bodyChars: number): Promise<FullMessage> {
    this.getCalls++;
    if (this.failWith) throw this.failWith;
    const m = (this.inboxes.get(userId) ?? []).find((x) => x.id === id);
    if (!m) throw new AppError("NOT_FOUND", 404, "That email couldn't be found.");
    const { body, ...rest } = m;
    return { ...rest, bodyText: body.slice(0, bodyChars), bodyTruncated: body.length > bodyChars };
  }
}

export class FakeAi implements AiProvider {
  readonly mode = "live" as const;
  classifyCalls = 0;
  summarizeCalls = 0;
  lastSummaryRequest: SummaryRequest | null = null;
  lastCategories: CategoryForAi[] = [];
  summaryText: string | ((req: SummaryRequest) => string) = (req) => `Summary of ${req.emails.length} email(s): ${req.emails.map((e) => e.subject).join("; ")}.`;
  delayMs = 0;
  failWith: AppError | null = null;
  classifyMap: (e: { subject: string; fromEmail: string }) => string = (e) =>
    e.fromEmail.endsWith(".edu") ? "School" : e.fromEmail.includes("work") ? "Work" : e.subject.includes("$") ? "Transactions" : e.fromEmail.startsWith("mom") ? "Personal" : "Promotions";

  async classify(emails: Array<{ id: string; subject: string; fromEmail: string; fromName: string; snippet: string }>, categories: CategoryForAi[]) {
    this.classifyCalls++;
    this.lastCategories = categories;
    if (this.failWith) throw this.failWith;
    return new Map(emails.map((e) => [e.id, this.classifyMap(e)]));
  }

  async summarize(req: SummaryRequest) {
    this.summarizeCalls++;
    this.lastSummaryRequest = req;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw this.failWith;
    return typeof this.summaryText === "function" ? this.summaryText(req) : this.summaryText;
  }
}

export class FakeVoice implements VoiceProvider {
  readonly mode = "live" as const;
  stock: StockVoice[] = [
    { providerVoiceId: "stock-a", name: "Aria", description: "", previewUrl: "https://example.com/a.mp3", labels: {} },
    { providerVoiceId: "stock-b", name: "Ben", description: "", previewUrl: null, labels: {} },
  ];
  canClone = true;
  synthCalls: Array<{ providerVoiceId: string; text: string; speed: number }> = [];
  cloneCalls: Array<{ name: string; files: CloneFile[]; removeBackgroundNoise: boolean }> = [];
  deleteCalls: string[] = [];
  addLibraryCalls: string[] = [];
  delayMs = 0;
  synthFail: AppError | null = null;
  deleteFail: AppError | null = null;
  private cloneN = 0;

  async listStockVoices() {
    return this.stock;
  }
  async searchLibrary() {
    return {
      voices: [
        {
          publicOwnerId: "owner1",
          providerVoiceId: "libvoice1",
          name: "Narrator",
          description: "",
          previewUrl: null,
          category: "professional",
          language: "en",
          accent: null,
          gender: null,
          age: null,
          useCase: null,
        },
      ],
      hasMore: false,
    };
  }
  async addLibraryVoice(_owner: string, voiceId: string) {
    this.addLibraryCalls.push(voiceId);
    return `added-${voiceId}`;
  }
  async capabilities() {
    return { canClone: this.canClone, quotaRemaining: 0.5 };
  }
  async createClone(input: { name: string; description: string; files: CloneFile[]; removeBackgroundNoise: boolean }) {
    this.cloneCalls.push({ name: input.name, files: input.files, removeBackgroundNoise: input.removeBackgroundNoise });
    this.cloneN++;
    return { providerVoiceId: `clone-${this.cloneN}`, requiresVerification: false };
  }
  async deleteVoice(id: string) {
    this.deleteCalls.push(id);
    if (this.deleteFail) throw this.deleteFail;
  }
  async synthesize(input: { providerVoiceId: string; text: string; speed: number }) {
    this.synthCalls.push(input);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.synthFail) throw this.synthFail;
    return { audio: Buffer.from(`ID3-fake-mp3:${input.providerVoiceId}:${input.text.length}`), mime: "audio/mpeg", extension: "mp3" };
  }
}

export class FakeGoogleAuth implements GoogleAuthProvider {
  revoked: string[] = [];
  identities = new Map<string, Partial<GoogleIdentity>>();
  exchangeFail: AppError | null = null;

  authorizationUrl(state: string) {
    return `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`;
  }
  async exchangeCode(code: string): Promise<GoogleIdentity> {
    if (this.exchangeFail) throw this.exchangeFail;
    const extra = this.identities.get(code) ?? {};
    return {
      sub: `sub-${code}`,
      email: `${code}@gmail.test`,
      name: code.charAt(0).toUpperCase() + code.slice(1),
      accessToken: `access-${code}`,
      refreshToken: `refresh-${code}`,
      expiresAt: Date.now() + 3600_000,
      scope: GMAIL_SCOPE,
      ...extra,
    };
  }
  async refresh(refreshToken: string) {
    return { accessToken: `access-refreshed-${refreshToken}`, expiresAt: Date.now() + 3600_000, scope: GMAIL_SCOPE };
  }
  async revoke(token: string) {
    this.revoked.push(token);
  }
}

export interface Harness {
  baseUrl: string;
  deps: AppDeps;
  services: AppServices;
  mail: FakeMail;
  ai: FakeAi;
  voice: FakeVoice;
  google: FakeGoogleAuth;
  config: AppConfig;
  dataDir: string;
  close: () => Promise<void>;
}

export async function startHarness(
  opts: {
    config?: Partial<AppConfig>;
    providers?: Partial<Providers>;
    limits?: Partial<AppConfig["limits"]>;
    rateLimits?: Partial<AppConfig["rateLimits"]>;
  } = {},
): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-voice-test-"));
  const base = loadConfig({}, { sessionSecret: "test-secret-".padEnd(48, "x"), dataDir });
  const config: AppConfig = {
    ...base,
    demoMode: true,
    google: { clientId: "test", clientSecret: "test", redirectUri: "http://localhost/auth/google/callback" },
    anthropic: { apiKey: "test", model: "claude-test", refusalFallback: true },
    elevenlabs: { apiKey: "test", modelId: "eleven_multilingual_v2", outputFormat: "mp3_44100_128", baseUrl: "https://api.elevenlabs.test", defaultVoiceId: null },
    ...opts.config,
    limits: { ...base.limits, ...opts.limits },
    rateLimits: { ...base.rateLimits, ...opts.rateLimits },
  };
  const store = new Store(dataDir);
  const files = new FileStore(dataDir);
  const mail = new FakeMail();
  const ai = new FakeAi();
  const voice = new FakeVoice();
  const google = new FakeGoogleAuth();
  const tokens = new GoogleTokenService(store, new TokenCipher(config.sessionSecret), google);
  const providers: Providers = {
    googleAuth: google,
    liveMail: mail,
    demoMail: new DemoMailProvider(),
    ai,
    voice,
    ...opts.providers,
  };
  const deps: AppDeps = { config, store, files, providers, tokens, limiter: new RateLimiter(), now: Date.now };
  const { app, services } = createApp(deps);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    deps,
    services,
    mail,
    ai,
    voice,
    google,
    config,
    dataDir,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
  raw: ArrayBuffer;
}

/** A browser-like client with its own cookie jar. */
export class Client {
  readonly baseUrl: string;
  cookies = new Map<string, string>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair!.split("=");
      const value = v.join("=");
      if (!value || /expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k!.trim());
      else this.cookies.set(k!.trim(), value);
    }
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async request<T = any>(method: string, p: string, opts: { json?: unknown; form?: FormData; csrf?: boolean; redirect?: "manual" | "follow" } = {}): Promise<Res<T>> {
    const headers: Record<string, string> = {};
    if (opts.csrf !== false) headers["x-inbox-voice"] = "1";
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form;
    }
    const res = await fetch(this.baseUrl + p, { method, headers, body, redirect: opts.redirect ?? "manual" });
    this.store(res);
    const raw = await res.arrayBuffer();
    let parsed: unknown = null;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("json")) parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
    return { status: res.status, body: parsed as T, headers: res.headers, raw };
  }

  get<T = any>(p: string) {
    return this.request<T>("GET", p);
  }
  post<T = any>(p: string, json?: unknown) {
    return this.request<T>("POST", p, json === undefined ? {} : { json });
  }
  patch<T = any>(p: string, json?: unknown) {
    return this.request<T>("PATCH", p, { json });
  }
  put<T = any>(p: string, json?: unknown) {
    return this.request<T>("PUT", p, { json });
  }
  del<T = any>(p: string) {
    return this.request<T>("DELETE", p);
  }

  /** Runs the full Google sign-in redirect dance against the fake Google provider. */
  async signInWithGoogle(code: string): Promise<Res> {
    const start = await this.get("/auth/google/start");
    const location = start.headers.get("location") ?? "";
    const state = new URL(location).searchParams.get("state") ?? "";
    return this.get(`/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  }

  async consent(version = "2026-11-14") {
    return this.post("/api/consent", { accept: true, version });
  }
}

/** Signs in a Google user with a sample inbox and AI consent. */
export async function signedInUser(h: Harness, code: string, opts: { consent?: boolean } = {}) {
  const client = new Client(h.baseUrl);
  const res = await client.signInWithGoogle(code);
  if (res.status !== 302 || res.headers.get("location") !== "/") throw new Error(`sign-in failed: ${res.status} ${res.headers.get("location")}`);
  const me = await client.get("/api/me");
  const userId: string = me.body.user.id;
  h.mail.setInbox(userId, sampleMessages(`${code}-m`));
  if (opts.consent !== false) {
    const c = await client.consent();
    if (c.status !== 200) throw new Error("consent failed");
  }
  return { client, userId };
}

export function audioFilesFor(h: Harness, userId: string): string[] {
  const dir = path.join(h.dataDir, "audio", userId);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}
