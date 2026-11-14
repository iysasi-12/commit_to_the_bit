import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { runHousekeeping } from "../server/app.ts";
import { AppError } from "../server/errors.ts";
import { audioFilesFor, Client, sampleMessages, signedInUser, startHarness, type Harness } from "./helpers.ts";

describe("inbox, filter, summaries and audio", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.deps.limiter.reset();
    h.ai.failWith = null;
    h.voice.synthFail = null;
    h.ai.delayMs = 0;
    h.voice.delayMs = 0;
  });

  it("lists the inbox newest first and sorts it into categories", async () => {
    const { client } = await signedInUser(h, "sorter");
    const inbox = await client.get("/api/inbox");
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.messages.length, 5);
    assert.equal(inbox.body.unclassified, 5);
    assert.ok(inbox.body.messages[0].internalDate >= inbox.body.messages[1].internalDate);

    const sorted = await client.post("/api/inbox/classify");
    assert.equal(sorted.status, 200);
    assert.equal(sorted.body.assigned, 5);
    assert.equal(sorted.body.unclassified, 0);
    const cats = (await client.get("/api/categories")).body.categories as Array<{ id: string; name: string }>;
    const nameOf = (id: string) => cats.find((c) => c.id === id)?.name;
    const bySubject = Object.fromEntries((sorted.body.messages as Array<{ subject: string; categoryId: string }>).map((m) => [m.subject, nameOf(m.categoryId)]));
    assert.equal(bySubject["Lab report due Friday"], "School");
    assert.equal(bySubject["Cover Saturday shift?"], "Work");
    assert.equal(bySubject["Payment of $48.20 due Nov 20"], "Transactions");
    assert.equal(bySubject["Dinner Sunday?"], "Personal");

    const before = h.ai.classifyCalls;
    await client.post("/api/inbox/classify");
    assert.equal(h.ai.classifyCalls, before, "already-sorted emails aren't sent again");
    assert.deepEqual(
      h.ai.lastCategories.map((c) => c.name).at(-1),
      "Other",
      "fallback category is listed last",
    );
  });

  it("re-sorts after categories change, and validates category edits", async () => {
    const { client } = await signedInUser(h, "catedit");
    await client.post("/api/inbox/classify");
    const calls = h.ai.classifyCalls;
    const add = await client.post("/api/categories", { name: "Sports", description: "Practices and games" });
    assert.equal(add.status, 201);
    const after = await client.get("/api/inbox");
    assert.equal(after.body.unclassified, 5, "classifications reset when categories change");
    await client.post("/api/inbox/classify");
    assert.equal(h.ai.classifyCalls, calls + 1);
    assert.ok(h.ai.lastCategories.some((c) => c.name === "Sports"));

    const dup = await client.post("/api/categories", { name: "sports" });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error.message, /already have/);
    const empty = await client.post("/api/categories", { name: "  " });
    assert.equal(empty.status, 400);
    const cats = add.body.categories as Array<{ id: string; isFallback: boolean }>;
    const fallback = cats.find((c) => c.isFallback)!;
    assert.equal((await client.del(`/api/categories/${fallback.id}`)).status, 400, "catch-all can't be deleted");
    for (let i = 0; i < 10; i++) await client.post("/api/categories", { name: `Extra ${i}` });
    const full = await client.post("/api/categories", { name: "One too many" });
    assert.equal(full.status, 409);
    const reset = await client.post("/api/categories/reset");
    assert.equal(reset.body.categories.length, 6);
  });

  it("generates a summary, then speech, and serves the audio privately", async () => {
    const { client, userId } = await signedInUser(h, "listener");
    const s = await client.post("/api/summaries", { scope: "many" });
    assert.equal(s.status, 200);
    assert.equal(s.body.cached, false);
    assert.equal(s.body.summary.messageCount, 5);
    assert.match(s.body.summary.text, /Summary of 5 email/);
    assert.equal(h.ai.lastSummaryRequest?.listenerName, "Listener");

    const a = await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    assert.equal(a.status, 200);
    assert.equal(a.body.cached, false);
    assert.equal(a.body.audio.voiceName, "Aria", "falls back to the first ready-made voice");
    assert.equal(h.voice.synthCalls.at(-1)?.text, s.body.summary.text, "the voice reads the summary text exactly");

    const file = await client.get(a.body.audio.url);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "audio/mpeg");
    assert.match(file.headers.get("cache-control") ?? "", /no-store/);
    assert.match(Buffer.from(file.raw).toString(), /^ID3-fake-mp3:stock-a:/);
    assert.equal(audioFilesFor(h, userId).length, 1);
  });

  it("serves replays from cache without paying again", async () => {
    const { client } = await signedInUser(h, "replayer");
    const s1 = await client.post("/api/summaries", { scope: "many" });
    const aiCalls = h.ai.summarizeCalls;
    const s2 = await client.post("/api/summaries", { scope: "many" });
    assert.equal(s2.body.cached, true);
    assert.equal(s2.body.summary.id, s1.body.summary.id);
    assert.equal(h.ai.summarizeCalls, aiCalls, "no second AI call");

    const synth = h.voice.synthCalls.length;
    const a1 = await client.post(`/api/summaries/${s1.body.summary.id}/audio`);
    const a2 = await client.post(`/api/summaries/${s1.body.summary.id}/audio`);
    assert.equal(a2.body.cached, true);
    assert.equal(a2.body.audio.id, a1.body.audio.id);
    assert.equal(h.voice.synthCalls.length, synth + 1, "only one paid speech request");
  });

  it("collapses simultaneous duplicate requests into one provider call", async () => {
    const { client } = await signedInUser(h, "doubletap");
    h.ai.delayMs = 80;
    const aiBefore = h.ai.summarizeCalls;
    const results = await Promise.all([1, 2, 3].map(() => client.post("/api/summaries", { scope: "one", messageId: "doubletap-m1" })));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(new Set(results.map((r) => r.body.summary.id)).size, 1);
    assert.equal(h.ai.summarizeCalls, aiBefore + 1);

    h.voice.delayMs = 80;
    const synthBefore = h.voice.synthCalls.length;
    const id = results[0]!.body.summary.id;
    const audios = await Promise.all([1, 2, 3, 4].map(() => client.post(`/api/summaries/${id}/audio`)));
    assert.ok(audios.every((r) => r.status === 200));
    assert.equal(new Set(audios.map((r) => r.body.audio.id)).size, 1);
    assert.equal(h.voice.synthCalls.length, synthBefore + 1);
  });

  it("summarizes one email and a single category", async () => {
    const { client } = await signedInUser(h, "scoped");
    const one = await client.post("/api/summaries", { scope: "one", messageId: "scoped-m4" });
    assert.equal(one.status, 200);
    assert.equal(one.body.summary.title, 'Summary of "Dinner Sunday?"');
    assert.equal(h.ai.lastSummaryRequest?.scope, "one");

    const cats = (await client.get("/api/categories")).body.categories as Array<{ id: string; name: string }>;
    const school = cats.find((c) => c.name === "School")!;
    const cat = await client.post("/api/summaries", { scope: "many", categoryId: school.id });
    assert.equal(cat.status, 200);
    assert.equal(cat.body.summary.messageCount, 1);
    assert.equal(h.ai.lastSummaryRequest?.scopeLabel, "your School emails");
    assert.deepEqual(
      h.ai.lastSummaryRequest?.emails.map((e) => e.subject),
      ["Lab report due Friday"],
    );

    const work = cats.find((c) => c.name === "Promotions")!;
    await client.del(`/api/categories/${cats.find((c) => c.name === "Personal")!.id}`);
    const promos = await client.post("/api/summaries", { scope: "many", categoryId: work.id });
    assert.equal(promos.status, 200);

    const missing = await client.post("/api/summaries", { scope: "one", messageId: "not-mine" });
    assert.equal(missing.status, 404);
  });

  it("keeps people's data apart", async () => {
    const a = await signedInUser(h, "alice");
    const b = await signedInUser(h, "bob");
    const s = await a.client.post("/api/summaries", { scope: "many" });
    const audio = await a.client.post(`/api/summaries/${s.body.summary.id}/audio`);

    assert.equal((await b.client.get(audio.body.audio.url)).status, 404, "can't fetch someone else's audio");
    assert.equal((await b.client.post(`/api/summaries/${s.body.summary.id}/audio`)).status, 404, "can't voice someone else's summary");
    assert.equal((await b.client.post("/api/summaries", { scope: "one", messageId: "alice-m1" })).status, 404, "can't read someone else's email");
    const aCats = (await a.client.get("/api/categories")).body.categories as Array<{ id: string }>;
    assert.equal((await b.client.patch(`/api/categories/${aCats[0]!.id}`, { name: "Hacked" })).status, 404);
    assert.equal((await b.client.del(`/api/categories/${aCats[0]!.id}`)).status, 404);
    const bInbox = await b.client.get("/api/inbox");
    assert.ok((bInbox.body.messages as Array<{ id: string }>).every((m) => m.id.startsWith("bob-")));
  });

  it("caps summary length before it reaches text-to-speech", async () => {
    const { client } = await signedInUser(h, "longwinded");
    h.ai.summaryText = "This is a sentence that goes on. ".repeat(200);
    try {
      const s = await client.post("/api/summaries", { scope: "many" });
      assert.ok(s.body.summary.text.length <= h.config.limits.ttsMaxChars);
      assert.ok(s.body.summary.text.endsWith("."));
      await client.post(`/api/summaries/${s.body.summary.id}/audio`);
      assert.ok(h.voice.synthCalls.at(-1)!.text.length <= h.config.limits.ttsMaxChars);
    } finally {
      h.ai.summaryText = (req) => `Summary of ${req.emails.length} email(s): ${req.emails.map((e) => e.subject).join("; ")}.`;
    }
  });

  it("passes provider failures through with actionable messages", async () => {
    const { client } = await signedInUser(h, "unlucky");
    h.ai.failWith = new AppError("AI_BUSY", 429, "The AI service is busy right now. Wait a moment and try again.", { retryable: true });
    const busy = await client.post("/api/summaries", { scope: "many" });
    assert.equal(busy.status, 429);
    assert.equal(busy.body.error.code, "AI_BUSY");
    assert.equal(busy.body.error.retryable, true);
    h.ai.failWith = null;

    const s = await client.post("/api/summaries", { scope: "many" });
    assert.equal(s.status, 200, "a failed attempt isn't cached");
    h.voice.synthFail = new AppError("VOICE_QUOTA", 402, "The ElevenLabs account behind this app is out of credits for this month.");
    const quota = await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    assert.equal(quota.status, 402);
    assert.match(quota.body.error.message, /out of credits/);
    h.voice.synthFail = null;
    const retry = await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    assert.equal(retry.status, 200, "summary survives a voice failure and audio works on retry");
    assert.equal(retry.body.cached, false);

    h.mail.failWith = new AppError("GMAIL_REAUTH", 401, "Your Gmail connection expired or was removed. Please sign in with Google again.");
    try {
      const reauth = await client.get("/api/inbox?refresh=1");
      assert.equal(reauth.status, 401);
      assert.equal(reauth.body.error.code, "GMAIL_REAUTH");
    } finally {
      h.mail.failWith = null;
    }
  });

  it("rate-limits paid work but not cached replays", async () => {
    const limited = await startHarness({ rateLimits: { summariesPerHour: 2, audioPerHour: 1 } });
    try {
      const { client } = await signedInUser(limited, "busy");
      const s1 = await client.post("/api/summaries", { scope: "one", messageId: "busy-m1" });
      await client.post("/api/summaries", { scope: "one", messageId: "busy-m2" });
      const third = await client.post("/api/summaries", { scope: "one", messageId: "busy-m3" });
      assert.equal(third.status, 429);
      assert.equal(third.body.error.code, "RATE_LIMITED");
      assert.ok(Number(third.headers.get("retry-after")) > 0);
      const replay = await client.post("/api/summaries", { scope: "one", messageId: "busy-m1" });
      assert.equal(replay.status, 200, "cached summary is still available");

      assert.equal((await client.post(`/api/summaries/${s1.body.summary.id}/audio`)).status, 200);
      assert.equal((await client.post(`/api/summaries/${s1.body.summary.id}/audio`)).status, 200, "cached audio replay isn't limited");
      const s2 = await client.post("/api/summaries", { scope: "one", messageId: "busy-m2" });
      assert.equal((await client.post(`/api/summaries/${s2.body.summary.id}/audio`)).status, 429);
    } finally {
      await limited.close();
    }
  });

  it("says clearly when a service isn't configured", async () => {
    const bare = await startHarness({ providers: { ai: null, voice: null } });
    try {
      const { client } = await signedInUser(bare, "nokeys");
      const s = await client.post("/api/summaries", { scope: "many" });
      assert.equal(s.status, 503);
      assert.equal(s.body.error.code, "NOT_CONFIGURED");
      assert.match(s.body.error.message, /ANTHROPIC_API_KEY/);
      const v = await client.get("/api/voices");
      assert.equal(v.body.mode, "unavailable");
      assert.match(v.body.stockError, /ELEVENLABS_API_KEY/);
      const cfg = await client.get("/api/config");
      assert.deepEqual(cfg.body.services, { gmail: "live", ai: "unavailable", voice: "unavailable" });
    } finally {
      await bare.close();
    }
  });

  it("turning AI off deletes generated summaries and audio", async () => {
    const { client, userId } = await signedInUser(h, "revoker");
    await client.post("/api/inbox/classify");
    const s = await client.post("/api/summaries", { scope: "many" });
    const a = await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    assert.equal(audioFilesFor(h, userId).length, 1);

    const off = await client.del("/api/consent");
    assert.equal(off.body.user.consent.accepted, false);
    assert.equal(audioFilesFor(h, userId).length, 0, "audio files removed from disk");
    assert.equal((await client.get(a.body.audio.url)).status, 404);
    assert.equal((await client.post(`/api/summaries/${s.body.summary.id}/audio`)).status, 403);
    const inbox = await client.get("/api/inbox");
    assert.equal(inbox.body.unclassified, 5, "AI sorting results removed too");
  });

  it("clears generated content on request and expires it automatically", async () => {
    const { client, userId } = await signedInUser(h, "tidy");
    const s = await client.post("/api/summaries", { scope: "many" });
    await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    const cleared = await client.post("/api/account/clear-cache");
    assert.equal(cleared.body.audioFiles, 1);
    assert.equal(audioFilesFor(h, userId).length, 0);

    const s2 = await client.post("/api/summaries", { scope: "many" });
    assert.equal(s2.body.cached, false, "summary cache was cleared too");
    await client.post(`/api/summaries/${s2.body.summary.id}/audio`);
    const realNow = h.deps.now;
    h.deps.now = () => realNow() + (h.config.cacheTtlHours + 1) * 3600_000;
    try {
      runHousekeeping(h.deps);
    } finally {
      h.deps.now = realNow;
    }
    assert.equal(audioFilesFor(h, userId).length, 0, "expired audio deleted");
  });

  it("deletes the whole account, revoking Google and removing files", async () => {
    const { client, userId } = await signedInUser(h, "goodbye");
    const s = await client.post("/api/summaries", { scope: "many" });
    await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    const res = await client.del("/api/account");
    assert.equal(res.status, 200);
    assert.equal(res.body.googleRevoked, true);
    assert.ok(h.google.revoked.includes("refresh-goodbye"), "refresh token revoked at Google");
    assert.equal(fs.existsSync(path.join(h.dataDir, "audio", userId)), false);
    assert.equal((await client.get("/api/me")).status, 401);
    assert.equal(h.deps.store.getUser(userId), undefined);
  });

  it("reads a single message for display", async () => {
    const { client } = await signedInUser(h, "reader");
    const m = await client.get("/api/messages/reader-m2");
    assert.equal(m.status, 200);
    assert.match(m.body.message.bodyText, /cover Saturday/);
    assert.equal((await client.get("/api/messages/..%2F..%2Fetc")).status, 404, "ids are validated");
  });
});

describe("demo mode end to end (built-in stand-ins, no outside calls)", () => {
  it("signs in, sorts, summarizes and plays placeholder audio", async () => {
    const { DemoAiProvider, DemoVoiceProvider } = await import("../server/providers/demo.ts");
    const h = await startHarness({ providers: { ai: new DemoAiProvider(), voice: new DemoVoiceProvider(), googleAuth: null, liveMail: null } });
    try {
      const c = new Client(h.baseUrl);
      assert.equal((await c.post("/api/auth/demo")).status, 201);
      const me = await c.get("/api/me");
      assert.equal(me.body.user.isDemo, true);
      assert.equal((await c.consent()).status, 200);
      const inbox = await c.get("/api/inbox");
      assert.equal(inbox.body.messages.length, 14);
      const sorted = await c.post("/api/inbox/classify");
      const cats = (await c.get("/api/categories")).body.categories as Array<{ id: string; name: string }>;
      const rivera = (sorted.body.messages as Array<{ fromName: string; categoryId: string }>).find((m) => m.fromName === "Ms. Rivera")!;
      assert.equal(cats.find((x) => x.id === rivera.categoryId)?.name, "School");
      const s = await c.post("/api/summaries", { scope: "many" });
      assert.match(s.body.summary.text, /demo summary written without AI/);
      assert.equal(s.body.summary.aiMode, "demo");
      const a = await c.post(`/api/summaries/${s.body.summary.id}/audio`);
      assert.equal(a.body.audio.voiceMode, "demo");
      const file = await c.get(a.body.audio.url);
      assert.equal(Buffer.from(file.raw).subarray(0, 4).toString(), "RIFF");
      const cfg = await c.get("/api/config");
      assert.deepEqual(cfg.body.services, { gmail: "unavailable", ai: "demo", voice: "demo" });
      assert.doesNotMatch(s.body.summary.text, /[?.!]\./, "no doubled punctuation");
      assert.ok(sampleMessages("x").length > 0);
    } finally {
      await h.close();
    }
  });
});
