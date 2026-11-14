import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../server/config.ts";
import { AppError } from "../server/errors.ts";
import { GeminiAiProvider } from "../server/providers/gemini.ts";
import type { SummaryRequest } from "../server/providers/types.ts";

/**
 * MOCKED: the official @google/genai SDK runs for real, but global fetch is replaced,
 * so nothing reaches Google. These tests check request shape and error handling only.
 */
interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockGemini(respond: () => { status?: number; body: unknown }) {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    const rawBody = init.body ?? (input instanceof Request ? await input.text() : "{}");
    calls.push({ url, headers, body: JSON.parse(String(rawBody)) });
    const r = respond();
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

function reply(text: string, finishReason = "STOP") {
  return { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason }] };
}

const cfg = { apiKey: "AIza-test-key", model: "gemini-3.8-flash" };
const req: SummaryRequest = {
  emails: [{ id: "1", fromName: "Mom", fromEmail: "mom@x.com", subject: "Dinner", date: "2026-11-14T12:00:00Z", text: "Dinner at 6.", truncated: false }],
  scope: "one",
  scopeLabel: "this email",
  length: "brief",
  listenerName: "Alex",
};

describe("Gemini provider (mocked HTTP through the official SDK)", () => {
  it("sends a summary request to the chosen model with the system rules", async () => {
    const calls = mockGemini(() => ({ body: reply("**Mom** says dinner is at 6.") }));
    const text = await new GeminiAiProvider(cfg).summarize(req);
    assert.equal(text, "Mom says dinner is at 6.");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /models\/gemini-3\.8-flash:generateContent/);
    assert.equal(calls[0]!.headers.get("x-goog-api-key"), "AIza-test-key");
    assert.ok(!calls[0]!.url.includes("AIza-test-key"), "key is not put in the URL");
    const body = JSON.stringify(calls[0]!.body);
    assert.match(body, /untrusted data/, "system instruction included");
    assert.match(body, /Dinner at 6\./);
  });

  it("asks for JSON matching the category schema when sorting", async () => {
    const calls = mockGemini(() => ({ body: reply(JSON.stringify({ results: [{ id: "a", category: "School" }, { id: "b", category: "Nope" }] })) }));
    const out = await new GeminiAiProvider(cfg).classify(
      [
        { id: "a", fromName: "T", fromEmail: "t@x.edu", subject: "Quiz", snippet: "quiz" },
        { id: "b", fromName: "S", fromEmail: "s@x.com", subject: "Sale", snippet: "sale" },
      ],
      [
        { name: "School", description: "" },
        { name: "Other", description: "" },
      ],
    );
    assert.deepEqual([...out], [["a", "School"]]);
    const body = JSON.stringify(calls[0]!.body);
    assert.match(body, /application\/json/);
    assert.match(body, /"enum":\["School","Other"\]/);
  });

  it("maps a safety block to AI_REFUSED", async () => {
    mockGemini(() => ({ body: reply("", "SAFETY") }));
    await assert.rejects(new GeminiAiProvider(cfg).summarize(req), (e: unknown) => e instanceof AppError && e.code === "AI_REFUSED");
    mockGemini(() => ({ body: { promptFeedback: { blockReason: "SAFETY" }, candidates: [] } }));
    await assert.rejects(new GeminiAiProvider(cfg).summarize(req), (e: unknown) => e instanceof AppError && e.code === "AI_REFUSED");
  });

  it("maps a bad key to a config error naming GEMINI_API_KEY", async () => {
    mockGemini(() => ({ status: 401, body: { error: { code: 401, message: "API key not valid.", status: "UNAUTHENTICATED" } } }));
    await assert.rejects(new GeminiAiProvider(cfg).summarize(req), (e: unknown) => {
      assert.ok(e instanceof AppError);
      assert.equal(e.code, "AI_CONFIG");
      assert.match(e.message, /GEMINI_API_KEY/);
      return true;
    });
  });

  it("maps free-tier limits to a retryable, explained error", async () => {
    mockGemini(() => ({ status: 429, body: { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } } }));
    await assert.rejects(new GeminiAiProvider(cfg).summarize(req), (e: unknown) => {
      assert.ok(e instanceof AppError);
      assert.equal(e.code, "AI_BUSY");
      assert.equal(e.retryable, true);
      assert.match(e.message, /free-tier/);
      return true;
    });
  });

  it("maps a wrong model name to a config error", async () => {
    mockGemini(() => ({ status: 404, body: { error: { code: 404, message: "model not found", status: "NOT_FOUND" } } }));
    await assert.rejects(new GeminiAiProvider(cfg).summarize(req), (e: unknown) => e instanceof AppError && e.code === "AI_CONFIG" && /GEMINI_MODEL/.test(e.message));
  });
});

describe("choosing the AI provider from .env", () => {
  const base = { sessionSecret: "s".repeat(40) };
  it("uses Anthropic when both keys are set, unless AI_PROVIDER says gemini", () => {
    assert.equal(loadConfig({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" }, base).aiProvider, "anthropic");
    assert.equal(loadConfig({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", AI_PROVIDER: "gemini" }, base).aiProvider, "gemini");
  });
  it("uses Gemini when it's the only key, with a stable default model", () => {
    const c = loadConfig({ GEMINI_API_KEY: "g" }, base);
    assert.equal(c.aiProvider, "gemini");
    assert.equal(c.gemini?.model, "gemini-3.8-flash");
  });
  it("uses nothing when the chosen provider has no key, and rejects typos", () => {
    assert.equal(loadConfig({ AI_PROVIDER: "gemini" }, base).aiProvider, null);
    assert.throws(() => loadConfig({ AI_PROVIDER: "gemni" }, base), /AI_PROVIDER/);
  });
});
