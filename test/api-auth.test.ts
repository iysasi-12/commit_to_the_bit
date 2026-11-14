import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { AppError } from "../server/errors.ts";
import { Client, signedInUser, startHarness, type Harness } from "./helpers.ts";

describe("sign-in, sessions and request safety", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.close();
  });

  it("requires a session for every private endpoint", async () => {
    const anon = new Client(h.baseUrl);
    const checks: Array<[string, string]> = [
      ["GET", "/api/me"],
      ["GET", "/api/inbox"],
      ["POST", "/api/inbox/classify"],
      ["GET", "/api/messages/abc"],
      ["POST", "/api/summaries"],
      ["POST", "/api/summaries/abc/audio"],
      ["GET", "/api/audio/abc"],
      ["GET", "/api/voices"],
      ["POST", "/api/voices/clone"],
      ["DELETE", "/api/voices/abc"],
      ["GET", "/api/categories"],
      ["DELETE", "/api/account"],
    ];
    for (const [method, path] of checks) {
      const res = await anon.request(method, path, method === "POST" ? { json: {} } : {});
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.body.error.code, "UNAUTHENTICATED");
    }
  });

  it("blocks state-changing calls without the CSRF header", async () => {
    const { client } = await signedInUser(h, "csrf");
    const res = await client.request("POST", "/api/summaries", { json: { scope: "many" }, csrf: false });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "CSRF");
    const del = await client.request("DELETE", "/api/account", { csrf: false });
    assert.equal(del.status, 403);
    assert.equal((await client.get("/api/me")).status, 200, "account still exists");
  });

  it("completes Google sign-in and sets an HttpOnly session cookie", async () => {
    const c = new Client(h.baseUrl);
    const start = await c.get("/auth/google/start");
    assert.equal(start.status, 302);
    assert.match(start.headers.get("location") ?? "", /^https:\/\/accounts\.google\.test\/auth\?state=/);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cb = await c.get(`/auth/google/callback?code=ana&state=${encodeURIComponent(state)}`);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/");
    const setCookie = cb.headers.getSetCookie().find((x) => x.startsWith("iv_session="))!;
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const me = await c.get("/api/me");
    assert.equal(me.body.user.email, "ana@gmail.test");
    assert.equal(me.body.user.consent.accepted, false);
  });

  it("rejects a callback whose state doesn't match this browser", async () => {
    const attacker = new Client(h.baseUrl);
    const start = await attacker.get("/auth/google/start");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const victim = new Client(h.baseUrl);
    const res = await victim.get(`/auth/google/callback?code=evil&state=${encodeURIComponent(state)}`);
    assert.equal(res.headers.get("location"), "/?signin_error=STATE_MISMATCH");
    assert.equal((await victim.get("/api/me")).status, 401);
  });

  it("rejects a replayed state", async () => {
    const c = new Client(h.baseUrl);
    const start = await c.get("/auth/google/start");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cookie = c.cookies.get("iv_oauth")!;
    const first = await c.get(`/auth/google/callback?code=rep&state=${encodeURIComponent(state)}`);
    assert.equal(first.headers.get("location"), "/");
    c.cookies.set("iv_oauth", cookie);
    const second = await c.get(`/auth/google/callback?code=rep&state=${encodeURIComponent(state)}`);
    assert.equal(second.headers.get("location"), "/?signin_error=STATE_MISMATCH");
  });

  it("reports Google cancel and missing-scope errors by code only", async () => {
    const c = new Client(h.baseUrl);
    const cancelled = await c.get("/auth/google/callback?error=access_denied");
    assert.equal(cancelled.headers.get("location"), "/?signin_error=ACCESS_DENIED");
    h.google.exchangeFail = new AppError("GMAIL_SCOPE_MISSING", 403, "needs gmail");
    try {
      const res = await c.signInWithGoogle("noscope");
      assert.equal(res.headers.get("location"), "/?signin_error=GMAIL_SCOPE_MISSING");
    } finally {
      h.google.exchangeFail = null;
    }
  });

  it("signs out by deleting the session", async () => {
    const { client } = await signedInUser(h, "leaver");
    const token = client.cookies.get("iv_session")!;
    assert.equal((await client.post("/api/auth/logout")).status, 200);
    const stale = new Client(h.baseUrl);
    stale.cookies.set("iv_session", token);
    assert.equal((await stale.get("/api/me")).status, 401, "old cookie no longer works");
  });

  it("rejects an outdated or missing consent version", async () => {
    const { client } = await signedInUser(h, "consenter", { consent: false });
    const bad = await client.post("/api/consent", { accept: true, version: "1999-01-01" });
    assert.equal(bad.status, 400);
    const blocked = await client.post("/api/summaries", { scope: "many" });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, "CONSENT_REQUIRED");
    const sort = await client.post("/api/inbox/classify");
    assert.equal(sort.body.error.code, "CONSENT_REQUIRED");
    assert.equal(h.ai.summarizeCalls + h.ai.classifyCalls, 0, "no AI call before consent");
  });

  it("validates settings strictly", async () => {
    const { client } = await signedInUser(h, "settings");
    assert.equal((await client.patch("/api/settings", { speakingSpeed: 3 })).status, 400);
    assert.equal((await client.patch("/api/settings", { evil: true })).status, 400);
    const ok = await client.patch("/api/settings", { speakingSpeed: 1.1, summaryLength: "detailed" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.settings.speakingSpeed, 1.1);
  });

  it("returns JSON 404 for unknown API routes and rejects malformed JSON", async () => {
    const { client } = await signedInUser(h, "misc");
    const missing = await client.get("/api/nope");
    assert.equal(missing.status, 404);
    const res = await fetch(h.baseUrl + "/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-inbox-voice": "1", cookie: client.cookieHeader() },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });

  it("sets protective headers", async () => {
    const res = await new Client(h.baseUrl).get("/api/health");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  });
});

describe("demo sign-in", () => {
  it("is unavailable when demo mode is off", async () => {
    const h = await startHarness({ config: { demoMode: false } });
    try {
      const res = await new Client(h.baseUrl).post("/api/auth/demo");
      assert.equal(res.status, 404);
    } finally {
      await h.close();
    }
  });
});
