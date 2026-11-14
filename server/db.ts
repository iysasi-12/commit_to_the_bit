import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomId } from "./crypto.ts";

export type SummaryLength = "brief" | "detailed";

export interface UserSettings {
  summaryLength: SummaryLength;
  speakingSpeed: number;
  summaryCount: number;
  autoPlay: boolean;
  autoSort: boolean;
}

export const DEFAULT_SETTINGS: UserSettings = {
  summaryLength: "brief",
  speakingSpeed: 1,
  summaryCount: 10,
  autoPlay: true,
  autoSort: true,
};

export interface UserRow {
  id: string;
  google_sub: string | null;
  email: string;
  name: string;
  is_demo: number;
  created_at: number;
  ai_consent_at: number | null;
  ai_consent_version: string | null;
  categories_version: number;
  selected_voice_ref: string | null;
  settings_json: string;
}

export interface CategoryRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  color: string;
  position: number;
  is_fallback: number;
}

export interface SummaryRow {
  id: string;
  user_id: string;
  cache_key: string;
  scope: string;
  title: string;
  text: string;
  message_count: number;
  truncated_count: number;
  ai_mode: string;
  created_at: number;
}

export type VoiceKind = "own" | "library";
export type VoiceStatus = "preview" | "approved";

export interface VoiceRow {
  id: string;
  user_id: string;
  kind: VoiceKind;
  provider_voice_id: string;
  name: string;
  status: VoiceStatus;
  consent_at: number | null;
  recording_path: string | null;
  created_at: number;
  meta_json: string;
}

export interface AudioRow {
  id: string;
  user_id: string;
  cache_key: string;
  summary_id: string | null;
  voice_ref: string;
  provider_voice_id: string;
  file_name: string;
  mime: string;
  bytes: number;
  chars: number;
  voice_mode: string;
  created_at: number;
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ai_consent_at INTEGER,
  ai_consent_version TEXT,
  categories_version INTEGER NOT NULL DEFAULT 1,
  selected_voice_ref TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS google_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_enc TEXT,
  access_token_enc TEXT,
  access_expires_at INTEGER,
  scope TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  position INTEGER NOT NULL,
  is_fallback INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS classifications (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  categories_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  truncated_count INTEGER NOT NULL DEFAULT 0,
  ai_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, cache_key)
);
CREATE TABLE IF NOT EXISTS voices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('own', 'library')),
  provider_voice_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preview', 'approved')),
  consent_at INTEGER,
  recording_path TEXT,
  created_at INTEGER NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS audio (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  summary_id TEXT,
  voice_ref TEXT NOT NULL,
  provider_voice_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  chars INTEGER NOT NULL,
  voice_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, cache_key)
);
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);
CREATE INDEX IF NOT EXISTS idx_voices_user ON voices(user_id);
CREATE INDEX IF NOT EXISTS idx_audio_user ON audio(user_id);
CREATE INDEX IF NOT EXISTS idx_summaries_user ON summaries(user_id);
`;

export const CATEGORY_COLORS = ["#e07a5f", "#3d8bfd", "#2a9d8f", "#9b5de5", "#f4a261", "#e76f51", "#43aa8b", "#577590", "#c06c84", "#6c757d", "#bc6c25", "#118ab2"];

export const DEFAULT_CATEGORIES: Array<{ name: string; description: string; fallback?: boolean }> = [
  { name: "School", description: "Classes, teachers, assignments, grades, school portals and campus news." },
  { name: "Work", description: "Job, coworkers, meetings, clients, schedules and work tools." },
  { name: "Transactions", description: "Receipts, orders, shipping, bills, bank and card alerts, payments and subscriptions." },
  { name: "Personal", description: "Friends and family writing to you directly." },
  { name: "Promotions", description: "Marketing, newsletters, sales, deals and social media notifications." },
  { name: "Other", description: "Anything that doesn't fit another category.", fallback: true },
];

/** Thin data-access layer over node:sqlite. Files referenced by rows live under dataDir. */
export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;

  constructor(dataDir: string, filename = "app.db") {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(filename === ":memory:" ? ":memory:" : path.join(dataDir, filename));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private one<T>(sql: string, ...params: Array<string | number | null>): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: Array<string | number | null>): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: Array<string | number | null>): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---------- users ----------

  getUser(id: string): UserRow | undefined {
    return this.one<UserRow>("SELECT * FROM users WHERE id = ?", id);
  }

  getUserByGoogleSub(sub: string): UserRow | undefined {
    return this.one<UserRow>("SELECT * FROM users WHERE google_sub = ?", sub);
  }

  createUser(input: { googleSub: string | null; email: string; name: string; isDemo: boolean; now: number }): UserRow {
    const id = randomId();
    this.transaction(() => {
      this.run(
        "INSERT INTO users (id, google_sub, email, name, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        input.googleSub,
        input.email,
        input.name,
        input.isDemo ? 1 : 0,
        input.now,
      );
      DEFAULT_CATEGORIES.forEach((c, i) => {
        this.run(
          "INSERT INTO categories (id, user_id, name, description, color, position, is_fallback) VALUES (?, ?, ?, ?, ?, ?, ?)",
          randomId(),
          id,
          c.name,
          c.description,
          CATEGORY_COLORS[i % CATEGORY_COLORS.length]!,
          i,
          c.fallback ? 1 : 0,
        );
      });
    });
    return this.getUser(id)!;
  }

  updateUserProfile(id: string, email: string, name: string): void {
    this.run("UPDATE users SET email = ?, name = ? WHERE id = ?", email, name, id);
  }

  setConsent(id: string, at: number | null, version: string | null): void {
    this.run("UPDATE users SET ai_consent_at = ?, ai_consent_version = ? WHERE id = ?", at, version, id);
  }

  setSelectedVoice(id: string, ref: string | null): void {
    this.run("UPDATE users SET selected_voice_ref = ? WHERE id = ?", ref, id);
  }

  getSettings(user: UserRow): UserSettings {
    let parsed: Partial<UserSettings> = {};
    try {
      parsed = JSON.parse(user.settings_json) as Partial<UserSettings>;
    } catch {
      parsed = {};
    }
    return { ...DEFAULT_SETTINGS, ...parsed };
  }

  saveSettings(id: string, settings: UserSettings): void {
    this.run("UPDATE users SET settings_json = ? WHERE id = ?", JSON.stringify(settings), id);
  }

  bumpCategoriesVersion(id: string): void {
    this.run("UPDATE users SET categories_version = categories_version + 1 WHERE id = ?", id);
  }

  deleteUser(id: string): void {
    this.run("DELETE FROM users WHERE id = ?", id);
  }

  // ---------- google tokens ----------

  getGoogleTokens(userId: string):
    | { refresh_token_enc: string | null; access_token_enc: string | null; access_expires_at: number | null; scope: string | null }
    | undefined {
    return this.one("SELECT refresh_token_enc, access_token_enc, access_expires_at, scope FROM google_tokens WHERE user_id = ?", userId);
  }

  saveGoogleTokens(userId: string, t: { refreshEnc?: string | null; accessEnc: string; expiresAt: number; scope: string }): void {
    const existing = this.getGoogleTokens(userId);
    if (!existing) {
      this.run(
        "INSERT INTO google_tokens (user_id, refresh_token_enc, access_token_enc, access_expires_at, scope) VALUES (?, ?, ?, ?, ?)",
        userId,
        t.refreshEnc ?? null,
        t.accessEnc,
        t.expiresAt,
        t.scope,
      );
      return;
    }
    this.run(
      "UPDATE google_tokens SET refresh_token_enc = COALESCE(?, refresh_token_enc), access_token_enc = ?, access_expires_at = ?, scope = ? WHERE user_id = ?",
      t.refreshEnc ?? null,
      t.accessEnc,
      t.expiresAt,
      t.scope,
      userId,
    );
  }

  deleteGoogleTokens(userId: string): void {
    this.run("DELETE FROM google_tokens WHERE user_id = ?", userId);
  }

  // ---------- sessions & oauth state ----------

  createSession(tokenHash: string, userId: string, now: number, ttlMs: number): void {
    this.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", tokenHash, userId, now, now + ttlMs);
  }

  getSessionUser(tokenHash: string, now: number): UserRow | undefined {
    return this.one<UserRow>(
      "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
      tokenHash,
      now,
    );
  }

  deleteSession(tokenHash: string): void {
    this.run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  saveOAuthState(stateHash: string, now: number): void {
    this.run("INSERT INTO oauth_states (state_hash, created_at) VALUES (?, ?)", stateHash, now);
  }

  /** Returns true once per state; the row is deleted so a state can't be replayed. */
  consumeOAuthState(stateHash: string, now: number, maxAgeMs: number): boolean {
    const row = this.one<{ created_at: number }>("SELECT created_at FROM oauth_states WHERE state_hash = ?", stateHash);
    if (!row) return false;
    this.run("DELETE FROM oauth_states WHERE state_hash = ?", stateHash);
    return now - row.created_at <= maxAgeMs;
  }

  // ---------- categories & classifications ----------

  listCategories(userId: string): CategoryRow[] {
    return this.all<CategoryRow>("SELECT * FROM categories WHERE user_id = ? ORDER BY position, name", userId);
  }

  getCategory(userId: string, id: string): CategoryRow | undefined {
    return this.one<CategoryRow>("SELECT * FROM categories WHERE user_id = ? AND id = ?", userId, id);
  }

  insertCategory(userId: string, name: string, description: string, color: string): CategoryRow {
    const id = randomId();
    const pos = this.one<{ p: number | null }>("SELECT MAX(position) AS p FROM categories WHERE user_id = ? AND is_fallback = 0", userId)?.p ?? -1;
    // Keep the fallback category last.
    this.run("UPDATE categories SET position = position + 1 WHERE user_id = ? AND is_fallback = 1", userId);
    this.run(
      "INSERT INTO categories (id, user_id, name, description, color, position, is_fallback) VALUES (?, ?, ?, ?, ?, ?, 0)",
      id,
      userId,
      name,
      description,
      color,
      pos + 1,
    );
    return this.getCategory(userId, id)!;
  }

  updateCategory(userId: string, id: string, name: string, description: string): void {
    this.run("UPDATE categories SET name = ?, description = ? WHERE user_id = ? AND id = ?", name, description, userId, id);
  }

  deleteCategory(userId: string, id: string): void {
    this.run("DELETE FROM classifications WHERE user_id = ? AND category_id = ?", userId, id);
    this.run("DELETE FROM categories WHERE user_id = ? AND id = ?", userId, id);
  }

  replaceCategoriesWithDefaults(userId: string): void {
    this.transaction(() => {
      this.run("DELETE FROM classifications WHERE user_id = ?", userId);
      this.run("DELETE FROM categories WHERE user_id = ?", userId);
      DEFAULT_CATEGORIES.forEach((c, i) => {
        this.run(
          "INSERT INTO categories (id, user_id, name, description, color, position, is_fallback) VALUES (?, ?, ?, ?, ?, ?, ?)",
          randomId(),
          userId,
          c.name,
          c.description,
          CATEGORY_COLORS[i % CATEGORY_COLORS.length]!,
          i,
          c.fallback ? 1 : 0,
        );
      });
    });
  }

  getClassifications(userId: string, version: number): Map<string, string> {
    const rows = this.all<{ message_id: string; category_id: string }>(
      "SELECT message_id, category_id FROM classifications WHERE user_id = ? AND categories_version = ?",
      userId,
      version,
    );
    return new Map(rows.map((r) => [r.message_id, r.category_id]));
  }

  saveClassifications(userId: string, version: number, entries: Array<[string, string]>, now: number): void {
    this.transaction(() => {
      for (const [messageId, categoryId] of entries) {
        this.run(
          "INSERT INTO classifications (user_id, message_id, category_id, categories_version, created_at) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT (user_id, message_id) DO UPDATE SET category_id = excluded.category_id, categories_version = excluded.categories_version, created_at = excluded.created_at",
          userId,
          messageId,
          categoryId,
          version,
          now,
        );
      }
    });
  }

  deleteClassifications(userId: string): void {
    this.run("DELETE FROM classifications WHERE user_id = ?", userId);
  }

  // ---------- summaries ----------

  getSummary(userId: string, id: string): SummaryRow | undefined {
    return this.one<SummaryRow>("SELECT * FROM summaries WHERE user_id = ? AND id = ?", userId, id);
  }

  getSummaryByKey(userId: string, key: string): SummaryRow | undefined {
    return this.one<SummaryRow>("SELECT * FROM summaries WHERE user_id = ? AND cache_key = ?", userId, key);
  }

  insertSummary(row: Omit<SummaryRow, "id">): SummaryRow {
    const id = randomId();
    this.run(
      "INSERT INTO summaries (id, user_id, cache_key, scope, title, text, message_count, truncated_count, ai_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      row.user_id,
      row.cache_key,
      row.scope,
      row.title,
      row.text,
      row.message_count,
      row.truncated_count,
      row.ai_mode,
      row.created_at,
    );
    return this.getSummary(row.user_id, id)!;
  }

  deleteSummaries(userId: string): void {
    this.run("DELETE FROM summaries WHERE user_id = ?", userId);
  }

  // ---------- voices ----------

  listVoices(userId: string): VoiceRow[] {
    return this.all<VoiceRow>("SELECT * FROM voices WHERE user_id = ? ORDER BY created_at DESC", userId);
  }

  getVoice(userId: string, id: string): VoiceRow | undefined {
    return this.one<VoiceRow>("SELECT * FROM voices WHERE user_id = ? AND id = ?", userId, id);
  }

  countVoicesUsingProviderId(providerVoiceId: string): number {
    return this.one<{ n: number }>("SELECT COUNT(*) AS n FROM voices WHERE provider_voice_id = ?", providerVoiceId)?.n ?? 0;
  }

  insertVoice(row: Omit<VoiceRow, "id">): VoiceRow {
    const id = randomId();
    this.run(
      "INSERT INTO voices (id, user_id, kind, provider_voice_id, name, status, consent_at, recording_path, created_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      row.user_id,
      row.kind,
      row.provider_voice_id,
      row.name,
      row.status,
      row.consent_at,
      row.recording_path,
      row.created_at,
      row.meta_json,
    );
    return this.getVoice(row.user_id, id)!;
  }

  setVoiceStatus(userId: string, id: string, status: VoiceStatus): void {
    this.run("UPDATE voices SET status = ? WHERE user_id = ? AND id = ?", status, userId, id);
  }

  setVoiceRecordingPath(userId: string, id: string, recordingPath: string | null): void {
    this.run("UPDATE voices SET recording_path = ? WHERE user_id = ? AND id = ?", recordingPath, userId, id);
  }

  deleteVoiceRow(userId: string, id: string): void {
    this.run("DELETE FROM voices WHERE user_id = ? AND id = ?", userId, id);
  }

  // ---------- audio ----------

  getAudio(userId: string, id: string): AudioRow | undefined {
    return this.one<AudioRow>("SELECT * FROM audio WHERE user_id = ? AND id = ?", userId, id);
  }

  getAudioByKey(userId: string, key: string): AudioRow | undefined {
    return this.one<AudioRow>("SELECT * FROM audio WHERE user_id = ? AND cache_key = ?", userId, key);
  }

  insertAudio(row: Omit<AudioRow, "id"> & { id: string }): AudioRow {
    this.run(
      "INSERT INTO audio (id, user_id, cache_key, summary_id, voice_ref, provider_voice_id, file_name, mime, bytes, chars, voice_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.user_id,
      row.cache_key,
      row.summary_id,
      row.voice_ref,
      row.provider_voice_id,
      row.file_name,
      row.mime,
      row.bytes,
      row.chars,
      row.voice_mode,
      row.created_at,
    );
    return this.getAudio(row.user_id, row.id)!;
  }

  listAudio(userId: string, filter: { voiceRef?: string } = {}): AudioRow[] {
    if (filter.voiceRef) {
      return this.all<AudioRow>("SELECT * FROM audio WHERE user_id = ? AND voice_ref = ?", userId, filter.voiceRef);
    }
    return this.all<AudioRow>("SELECT * FROM audio WHERE user_id = ?", userId);
  }

  deleteAudioRow(userId: string, id: string): void {
    this.run("DELETE FROM audio WHERE user_id = ? AND id = ?", userId, id);
  }

  // ---------- housekeeping ----------

  expiredAudio(before: number): AudioRow[] {
    return this.all<AudioRow>("SELECT * FROM audio WHERE created_at < ?", before);
  }

  purgeExpired(now: number, cacheBefore: number): void {
    this.run("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.run("DELETE FROM oauth_states WHERE created_at < ?", now - 15 * 60 * 1000);
    this.run("DELETE FROM summaries WHERE created_at < ?", cacheBefore);
  }
}
