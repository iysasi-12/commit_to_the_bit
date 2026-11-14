export type ProviderMode = "live" | "demo";

// ---------------- Mail ----------------

export interface InboxMessage {
  id: string;
  threadId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  /** ISO timestamp */
  date: string;
  /** Sort key: epoch ms */
  internalDate: number;
  snippet: string;
  unread: boolean;
}

export interface FullMessage extends InboxMessage {
  bodyText: string;
  bodyTruncated: boolean;
}

export interface MailProvider {
  readonly mode: ProviderMode;
  listInbox(userId: string, opts: { max: number; pageToken?: string }): Promise<{ messages: InboxMessage[]; nextPageToken?: string }>;
  getMessage(userId: string, id: string, bodyChars: number): Promise<FullMessage>;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
}

export interface GoogleAuthProvider {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<GoogleIdentity>;
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: number; scope: string }>;
  revoke(token: string): Promise<void>;
}

// ---------------- AI ----------------

export interface EmailForAi {
  id: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  date: string;
  text: string;
  truncated: boolean;
}

export interface CategoryForAi {
  name: string;
  description: string;
}

export interface SummaryRequest {
  emails: EmailForAi[];
  /** "one" = a single email the person opened; "many" = a briefing over several. */
  scope: "one" | "many";
  /** Human label for what is being summarized, e.g. "your latest 10 emails" or "your School emails". */
  scopeLabel: string;
  length: "brief" | "detailed";
  listenerName: string;
}

export type AiProviderName = "anthropic" | "gemini" | "demo";

export interface AiProvider {
  readonly mode: ProviderMode;
  readonly name: AiProviderName;
  /** Model id, used in cache keys so switching models never replays an old summary. */
  readonly model: string;
  /** Returns message id -> category name (always one of the given names). */
  classify(emails: Array<Pick<EmailForAi, "id" | "fromName" | "fromEmail" | "subject"> & { snippet: string }>, categories: CategoryForAi[]): Promise<Map<string, string>>;
  summarize(req: SummaryRequest): Promise<string>;
}

// ---------------- Voice ----------------

export interface StockVoice {
  providerVoiceId: string;
  name: string;
  description: string;
  previewUrl: string | null;
  labels: Record<string, string>;
}

export interface LibraryVoice {
  publicOwnerId: string;
  providerVoiceId: string;
  name: string;
  description: string;
  previewUrl: string | null;
  category: string;
  language: string | null;
  accent: string | null;
  gender: string | null;
  age: string | null;
  useCase: string | null;
}

export interface CloneFile {
  buffer: Buffer;
  filename: string;
  mime: string;
}

export interface VoiceCapabilities {
  canClone: boolean;
  /** Fraction of the monthly character quota still unused, if known. */
  quotaRemaining: number | null;
}

export interface VoiceProvider {
  readonly mode: ProviderMode;
  listStockVoices(): Promise<StockVoice[]>;
  searchLibrary(q: { search: string; page: number; pageSize: number }): Promise<{ voices: LibraryVoice[]; hasMore: boolean }>;
  addLibraryVoice(publicOwnerId: string, providerVoiceId: string, newName: string): Promise<string>;
  capabilities(): Promise<VoiceCapabilities>;
  createClone(input: { name: string; description: string; files: CloneFile[]; removeBackgroundNoise: boolean }): Promise<{ providerVoiceId: string; requiresVerification: boolean }>;
  deleteVoice(providerVoiceId: string): Promise<void>;
  synthesize(input: { providerVoiceId: string; text: string; speed: number }): Promise<{ audio: Buffer; mime: string; extension: string }>;
}
