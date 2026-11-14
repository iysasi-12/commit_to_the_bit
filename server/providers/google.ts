import { AppError, truncateDetail } from "../errors.ts";
import type { TokenCipher } from "../crypto.ts";
import type { Store } from "../db.ts";
import { extractBodyText, stripQuotedReplies, toInboxFields, truncateText, type GmailMessageResource } from "./gmailParse.ts";
import type { FullMessage, GoogleAuthProvider, GoogleIdentity, InboxMessage, MailProvider } from "./types.ts";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_SCOPES = ["openid", "email", "profile", GMAIL_READONLY_SCOPE];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

type FetchFn = typeof fetch;

function reauth(message = "Your Gmail connection expired or was removed. Please sign in with Google again."): AppError {
  return new AppError("GMAIL_REAUTH", 401, message);
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

/** Google OAuth 2.0 for web server apps (authorization code flow). */
export class GoogleOAuth implements GoogleAuthProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly fetchFn: FetchFn;

  constructor(cfg: { clientId: string; clientSecret: string; redirectUri: string }, fetchFn: FetchFn = fetch) {
    this.clientId = cfg.clientId;
    this.clientSecret = cfg.clientSecret;
    this.redirectUri = cfg.redirectUri;
    this.fetchFn = fetchFn;
  }

  authorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      include_granted_scopes: "true",
      // consent: makes Google return a refresh token every time; select_account: lets people pick which Gmail.
      prompt: "consent select_account",
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  private async tokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchFn(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      });
    } catch (err) {
      throw new AppError("GMAIL_UNAVAILABLE", 502, "Couldn't reach Google. Check your internet connection and try again.", { retryable: true, cause: err });
    }
    const json = await readJson(res);
    if (!res.ok) {
      const code = String(json.error ?? "");
      if (code === "invalid_grant") throw reauth();
      if (code === "invalid_client" || code === "unauthorized_client") {
        throw new AppError("GOOGLE_CONFIG", 503, "Google sign-in is misconfigured on this server. The app owner should check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.", {
          detail: truncateDetail(String(json.error_description ?? code)),
        });
      }
      if (code === "redirect_uri_mismatch") {
        throw new AppError("GOOGLE_CONFIG", 503, "Google rejected the redirect address. Add this server's /auth/google/callback URL to the OAuth client in Google Cloud.", {
          detail: truncateDetail(String(json.error_description ?? code)),
        });
      }
      throw new AppError("GMAIL_ERROR", 502, "Google sign-in failed. Please try again.", { detail: truncateDetail(JSON.stringify(json)) });
    }
    return json;
  }

  async exchangeCode(code: string): Promise<GoogleIdentity> {
    const json = await this.tokenRequest({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: "authorization_code",
    });
    const accessToken = String(json.access_token ?? "");
    const scope = String(json.scope ?? "");
    if (!accessToken) throw new AppError("GMAIL_ERROR", 502, "Google didn't return an access token. Please try again.");
    if (!scope.split(" ").includes(GMAIL_READONLY_SCOPE)) {
      throw new AppError(
        "GMAIL_SCOPE_MISSING",
        403,
        "The app needs permission to read your Gmail to summarize it. Sign in again and leave the \"View your email messages and settings\" box checked.",
      );
    }
    let profileRes: Response;
    try {
      profileRes = await this.fetchFn(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (err) {
      throw new AppError("GMAIL_UNAVAILABLE", 502, "Couldn't reach Google. Please try again.", { retryable: true, cause: err });
    }
    const profile = await readJson(profileRes);
    if (!profileRes.ok || !profile.sub) {
      throw new AppError("GMAIL_ERROR", 502, "Couldn't read your Google profile. Please try again.", { detail: truncateDetail(JSON.stringify(profile)) });
    }
    const email = String(profile.email ?? "");
    return {
      sub: String(profile.sub),
      email,
      name: String(profile.given_name ?? profile.name ?? email.split("@")[0] ?? "there"),
      accessToken,
      refreshToken: json.refresh_token ? String(json.refresh_token) : null,
      expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
      scope,
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: number; scope: string }> {
    const json = await this.tokenRequest({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    return {
      accessToken: String(json.access_token ?? ""),
      expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
      scope: String(json.scope ?? ""),
    };
  }

  async revoke(token: string): Promise<void> {
    const res = await this.fetchFn(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    // 400 invalid_token means it was already revoked or expired: nothing left to do.
    if (!res.ok && res.status !== 400) {
      throw new AppError("GMAIL_ERROR", 502, "Google didn't confirm the disconnect. You can also remove access at myaccount.google.com/permissions.");
    }
  }
}

/** Stores Google tokens encrypted and refreshes the access token when it is about to expire. */
export class GoogleTokenService {
  private readonly store: Store;
  private readonly cipher: TokenCipher;
  private readonly auth: GoogleAuthProvider;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(store: Store, cipher: TokenCipher, auth: GoogleAuthProvider) {
    this.store = store;
    this.cipher = cipher;
    this.auth = auth;
  }

  save(userId: string, identity: Pick<GoogleIdentity, "accessToken" | "refreshToken" | "expiresAt" | "scope">): void {
    this.store.saveGoogleTokens(userId, {
      accessEnc: this.cipher.encrypt(identity.accessToken),
      refreshEnc: identity.refreshToken ? this.cipher.encrypt(identity.refreshToken) : null,
      expiresAt: identity.expiresAt,
      scope: identity.scope,
    });
  }

  async getAccessToken(userId: string, forceRefresh = false): Promise<string> {
    const row = this.store.getGoogleTokens(userId);
    if (!row) throw reauth("Gmail isn't connected. Please sign in with Google.");
    if (!forceRefresh && row.access_token_enc && (row.access_expires_at ?? 0) > Date.now() + 60_000) {
      return this.cipher.decrypt(row.access_token_enc);
    }
    if (!row.refresh_token_enc) throw reauth();
    const key = userId;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const refreshed = await this.auth.refresh(this.cipher.decrypt(row.refresh_token_enc!));
      this.store.saveGoogleTokens(userId, {
        accessEnc: this.cipher.encrypt(refreshed.accessToken),
        expiresAt: refreshed.expiresAt,
        scope: refreshed.scope || row.scope || "",
      });
      return refreshed.accessToken;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Best-effort token revocation at Google, then local deletion. */
  async revokeAndForget(userId: string): Promise<{ revokedAtGoogle: boolean }> {
    const row = this.store.getGoogleTokens(userId);
    let revoked = false;
    if (row) {
      const token = row.refresh_token_enc ?? row.access_token_enc;
      if (token) {
        try {
          await this.auth.revoke(this.cipher.decrypt(token));
          revoked = true;
        } catch {
          revoked = false;
        }
      }
    }
    this.store.deleteGoogleTokens(userId);
    return { revokedAtGoogle: revoked };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Reads Gmail with the gmail.readonly scope. Never modifies or sends mail. */
export class GmailMailProvider implements MailProvider {
  readonly mode = "live" as const;
  private readonly tokens: GoogleTokenService;
  private readonly fetchFn: FetchFn;

  constructor(tokens: GoogleTokenService, fetchFn: FetchFn = fetch) {
    this.tokens = tokens;
    this.fetchFn = fetchFn;
  }

  private async call(userId: string, pathAndQuery: string, retried = false): Promise<Record<string, unknown>> {
    const token = await this.tokens.getAccessToken(userId, retried);
    let res: Response;
    try {
      res = await this.fetchFn(`${GMAIL_BASE}${pathAndQuery}`, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      throw new AppError("GMAIL_UNAVAILABLE", 502, "Couldn't reach Gmail. Check your connection and try again.", { retryable: true, cause: err });
    }
    if (res.status === 401 && !retried) return this.call(userId, pathAndQuery, true);
    const json = await readJson(res);
    if (res.ok) return json;
    const detail = truncateDetail(JSON.stringify(json.error ?? json));
    if (res.status === 401) throw reauth();
    if (res.status === 403) {
      const text = JSON.stringify(json).toLowerCase();
      if (text.includes("ratelimit") || text.includes("rate limit") || text.includes("quota")) {
        throw new AppError("GMAIL_RATE_LIMITED", 429, "Gmail is limiting requests right now. Wait a minute and try again.", { retryable: true, detail });
      }
      throw reauth("The app doesn't have permission to read this Gmail account. Sign in again and allow read access.");
    }
    if (res.status === 404) throw new AppError("NOT_FOUND", 404, "That email couldn't be found. It may have been deleted.");
    if (res.status === 429) throw new AppError("GMAIL_RATE_LIMITED", 429, "Gmail is limiting requests right now. Wait a minute and try again.", { retryable: true, detail });
    throw new AppError("GMAIL_UNAVAILABLE", 502, "Gmail had a problem answering. Please try again.", { retryable: true, detail });
  }

  async listInbox(userId: string, opts: { max: number; pageToken?: string }): Promise<{ messages: InboxMessage[]; nextPageToken?: string }> {
    const params = new URLSearchParams({ maxResults: String(opts.max), labelIds: "INBOX" });
    if (opts.pageToken) params.set("pageToken", opts.pageToken);
    const list = await this.call(userId, `/messages?${params.toString()}`);
    const ids = ((list.messages as Array<{ id: string }> | undefined) ?? []).map((m) => m.id);
    const meta = await mapLimit(ids, 5, (id) =>
      this.call(userId, `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`),
    );
    const messages = meta.map((m) => toInboxFields(m as unknown as GmailMessageResource));
    const nextPageToken = typeof list.nextPageToken === "string" ? list.nextPageToken : undefined;
    return nextPageToken ? { messages, nextPageToken } : { messages };
  }

  async getMessage(userId: string, id: string, bodyChars: number): Promise<FullMessage> {
    const msg = (await this.call(userId, `/messages/${encodeURIComponent(id)}?format=full`)) as unknown as GmailMessageResource;
    const base = toInboxFields(msg);
    const body = stripQuotedReplies(extractBodyText(msg.payload)) || base.snippet;
    const { text, truncated } = truncateText(body, bodyChars);
    return { ...base, bodyText: text, bodyTruncated: truncated };
  }
}
