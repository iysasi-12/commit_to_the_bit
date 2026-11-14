import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { TokenCipher } from "../server/crypto.ts";
import { Store } from "../server/db.ts";
import { AppError } from "../server/errors.ts";
import { GmailMailProvider, GoogleOAuth, GoogleTokenService, GMAIL_READONLY_SCOPE } from "../server/providers/google.ts";

type Handler = (url: URL, init: RequestInit) => Response;

function mockFetch(handler: Handler) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const cfg = { clientId: "cid.apps.googleusercontent.com", clientSecret: "secret", redirectUri: "http://localhost:3000/auth/google/callback" };

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iv-google-"));
  return { store: new Store(dir), dir };
}

describe("Google OAuth (mocked HTTP)", () => {
  it("builds an authorization URL with offline access, read-only Gmail scope and state", () => {
    const url = new URL(new GoogleOAuth(cfg).authorizationUrl("state123"));
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("client_id"), cfg.clientId);
    assert.equal(url.searchParams.get("redirect_uri"), cfg.redirectUri);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("state"), "state123");
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");
    assert.ok(scopes.includes(GMAIL_READONLY_SCOPE));
    assert.ok(!scopes.some((s) => s.includes("gmail.modify") || s.includes("gmail.send") || s === "https://mail.google.com/"), "never asks for write access");
  });

  it("exchanges a code and reads the profile", async () => {
    const { fn, calls } = mockFetch((url) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "at", refresh_token: "rt", expires_in: 3599, scope: `openid ${GMAIL_READONLY_SCOPE}` });
      return json({ sub: "123", email: "a@gmail.com", given_name: "Ana" });
    });
    const id = await new GoogleOAuth(cfg, fn).exchangeCode("the-code");
    assert.equal(id.sub, "123");
    assert.equal(id.name, "Ana");
    assert.equal(id.refreshToken, "rt");
    const body = new URLSearchParams(String(calls[0]!.init.body));
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "the-code");
    assert.equal(calls[1]!.url.toString(), "https://openidconnect.googleapis.com/v1/userinfo");
  });

  it("refuses sign-in when the person unchecked Gmail access", async () => {
    const { fn } = mockFetch(() => json({ access_token: "at", expires_in: 3599, scope: "openid email" }));
    await assert.rejects(new GoogleOAuth(cfg, fn).exchangeCode("c"), (e: unknown) => e instanceof AppError && e.code === "GMAIL_SCOPE_MISSING");
  });

  it("maps invalid_grant to a re-auth error and redirect mismatch to a config error", async () => {
    const grant = mockFetch(() => json({ error: "invalid_grant" }, 400));
    await assert.rejects(new GoogleOAuth(cfg, grant.fn).refresh("rt"), (e: unknown) => e instanceof AppError && e.code === "GMAIL_REAUTH");
    const redirect = mockFetch(() => json({ error: "redirect_uri_mismatch", error_description: "bad" }, 400));
    await assert.rejects(new GoogleOAuth(cfg, redirect.fn).exchangeCode("c"), (e: unknown) => e instanceof AppError && e.code === "GOOGLE_CONFIG");
  });

  it("treats revoking an already-invalid token as done", async () => {
    const { fn, calls } = mockFetch(() => json({ error: "invalid_token" }, 400));
    await new GoogleOAuth(cfg, fn).revoke("tok");
    assert.equal(calls[0]!.url.toString(), "https://oauth2.googleapis.com/revoke");
    assert.equal(new URLSearchParams(String(calls[0]!.init.body)).get("token"), "tok");
  });
});

describe("Gmail reads (mocked HTTP)", () => {
  it("stores tokens encrypted, lists INBOX metadata and fetches a full message", async () => {
    const { store, dir } = tempStore();
    try {
      const user = store.createUser({ googleSub: "s", email: "a@x", name: "A", isDemo: false, now: Date.now() });
      const cipher = new TokenCipher("x".repeat(40));
      const oauth = new GoogleOAuth(cfg, mockFetch(() => json({})).fn);
      const tokens = new GoogleTokenService(store, cipher, oauth);
      tokens.save(user.id, { accessToken: "AT-1", refreshToken: "RT-1", expiresAt: Date.now() + 3600_000, scope: GMAIL_READONLY_SCOPE });
      const row = store.getGoogleTokens(user.id)!;
      assert.ok(!row.access_token_enc!.includes("AT-1"), "access token is encrypted at rest");
      assert.ok(!row.refresh_token_enc!.includes("RT-1"), "refresh token is encrypted at rest");

      const body = Buffer.from("Practice moved to 4:30.", "utf8").toString("base64url");
      const { fn, calls } = mockFetch((url) => {
        if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
        const id = url.pathname.split("/").pop();
        if (url.searchParams.get("format") === "metadata") {
          return json({
            id,
            threadId: id,
            labelIds: ["INBOX"],
            snippet: `snippet ${id}`,
            internalDate: id === "m1" ? "2000" : "1000",
            payload: { headers: [{ name: "From", value: "Coach <c@school.edu>" }, { name: "Subject", value: `Subject ${id}` }] },
          });
        }
        return json({ id, threadId: id, labelIds: ["INBOX"], snippet: "s", internalDate: "1", payload: { mimeType: "text/plain", body: { data: body }, headers: [] } });
      });
      const gmail = new GmailMailProvider(tokens, fn);
      const list = await gmail.listInbox(user.id, { max: 2 });
      assert.deepEqual(
        list.messages.map((m) => m.subject),
        ["Subject m1", "Subject m2"],
      );
      assert.equal(calls[0]!.url.searchParams.get("labelIds"), "INBOX");
      assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer AT-1");
      const meta = calls.find((c) => c.url.pathname.endsWith("/m1"))!;
      assert.deepEqual(meta.url.searchParams.getAll("metadataHeaders"), ["From", "Subject", "Date"]);

      const full = await gmail.getMessage(user.id, "m9", 6000);
      assert.equal(full.bodyText, "Practice moved to 4:30.");
      assert.equal(calls.at(-1)!.url.searchParams.get("format"), "full");
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes an expired access token once on 401 and retries", async () => {
    const { store, dir } = tempStore();
    try {
      const user = store.createUser({ googleSub: "s", email: "a@x", name: "A", isDemo: false, now: Date.now() });
      let refreshes = 0;
      const oauthFetch = mockFetch(() => {
        refreshes++;
        return json({ access_token: "AT-NEW", expires_in: 3600, scope: GMAIL_READONLY_SCOPE });
      });
      const tokens = new GoogleTokenService(store, new TokenCipher("y".repeat(40)), new GoogleOAuth(cfg, oauthFetch.fn));
      tokens.save(user.id, { accessToken: "AT-OLD", refreshToken: "RT", expiresAt: Date.now() + 3600_000, scope: GMAIL_READONLY_SCOPE });
      const seen: string[] = [];
      const { fn } = mockFetch((_url, init) => {
        const auth = (init.headers as Record<string, string>).Authorization!;
        seen.push(auth);
        return auth === "Bearer AT-OLD" ? json({ error: { code: 401 } }, 401) : json({ messages: [] });
      });
      const out = await new GmailMailProvider(tokens, fn).listInbox(user.id, { max: 5 });
      assert.deepEqual(out.messages, []);
      assert.deepEqual(seen, ["Bearer AT-OLD", "Bearer AT-NEW"]);
      assert.equal(refreshes, 1);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps Gmail 403 rate limits and 404s", async () => {
    const { store, dir } = tempStore();
    try {
      const user = store.createUser({ googleSub: "s", email: "a@x", name: "A", isDemo: false, now: Date.now() });
      const tokens = new GoogleTokenService(store, new TokenCipher("z".repeat(40)), new GoogleOAuth(cfg, mockFetch(() => json({})).fn));
      tokens.save(user.id, { accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 3600_000, scope: GMAIL_READONLY_SCOPE });
      const limited = mockFetch(() => json({ error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }, 403));
      await assert.rejects(new GmailMailProvider(tokens, limited.fn).listInbox(user.id, { max: 1 }), (e: unknown) => e instanceof AppError && e.code === "GMAIL_RATE_LIMITED");
      const missing = mockFetch(() => json({ error: { code: 404 } }, 404));
      await assert.rejects(new GmailMailProvider(tokens, missing.fn).getMessage(user.id, "x", 100), (e: unknown) => e instanceof AppError && e.code === "NOT_FOUND");
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks the person to sign in again when no tokens are stored", async () => {
    const { store, dir } = tempStore();
    try {
      const tokens = new GoogleTokenService(store, new TokenCipher("w".repeat(40)), new GoogleOAuth(cfg));
      await assert.rejects(tokens.getAccessToken("nobody"), (e: unknown) => e instanceof AppError && e.code === "GMAIL_REAUTH");
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
