import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppError } from "../server/errors.ts";
import { ElevenLabsVoiceProvider, mapElevenLabsError } from "../server/providers/elevenlabs.ts";

interface Captured {
  url: string;
  init: RequestInit;
}

function mockFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const cfg = { apiKey: "xi-test-key", modelId: "eleven_multilingual_v2", outputFormat: "mp3_44100_128", baseUrl: "https://api.elevenlabs.io" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ElevenLabs provider (mocked HTTP)", () => {
  it("sends text-to-speech to the documented endpoint with the xi-api-key header", async () => {
    const { fn, calls } = mockFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const p = new ElevenLabsVoiceProvider(cfg, fn);
    const out = await p.synthesize({ providerVoiceId: "voice/123", text: "Hello there.", speed: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.elevenlabs.io/v1/text-to-speech/voice%2F123?output_format=mp3_44100_128");
    assert.equal(calls[0]!.init.method, "POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["xi-api-key"], "xi-test-key");
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(body, { text: "Hello there.", model_id: "eleven_multilingual_v2" });
    assert.equal(out.mime, "audio/mpeg");
    assert.equal(out.extension, "mp3");
    assert.equal(out.audio.length, 3);
  });

  it("only overrides voice_settings when speed differs from normal", async () => {
    const { fn, calls } = mockFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
    const p = new ElevenLabsVoiceProvider(cfg, fn);
    await p.synthesize({ providerVoiceId: "v", text: "Hi.", speed: 1.1 });
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)).voice_settings, { speed: 1.1 });
  });

  it("creates an Instant Voice Clone with multipart fields name, files, remove_background_noise", async () => {
    const { fn, calls } = mockFetch(() => json({ voice_id: "new-voice", requires_verification: false }));
    const p = new ElevenLabsVoiceProvider(cfg, fn);
    const out = await p.createClone({
      name: "Mom",
      description: "desc",
      files: [{ buffer: Buffer.from("audio-bytes"), filename: "rec.webm", mime: "audio/webm" }],
      removeBackgroundNoise: true,
    });
    assert.deepEqual(out, { providerVoiceId: "new-voice", requiresVerification: false });
    assert.equal(calls[0]!.url, "https://api.elevenlabs.io/v1/voices/add");
    const form = calls[0]!.init.body as FormData;
    assert.equal(form.get("name"), "Mom");
    assert.equal(form.get("remove_background_noise"), "true");
    const file = form.get("files") as File;
    assert.equal(file.name, "rec.webm");
    assert.equal(file.type, "audio/webm");
    assert.equal(await file.text(), "audio-bytes");
  });

  it("lists only premade voices so other people's clones are never offered", async () => {
    const { fn, calls } = mockFetch(() =>
      json({
        voices: [
          { voice_id: "p1", name: "Rachel", category: "premade", labels: { accent: "american" }, preview_url: "https://x/p1.mp3" },
          { voice_id: "c1", name: "Someone's clone", category: "cloned" },
          { voice_id: "g1", name: "Generated", category: "generated" },
        ],
      }),
    );
    const p = new ElevenLabsVoiceProvider(cfg, fn);
    const voices = await p.listStockVoices();
    assert.deepEqual(
      voices.map((v) => v.providerVoiceId),
      ["p1"],
    );
    assert.match(calls[0]!.url, /\/v2\/voices\?/);
    await p.listStockVoices();
    assert.equal(calls.length, 1, "stock voices are cached");
  });

  it("reads clone capability from the subscription endpoint", async () => {
    const { fn, calls } = mockFetch(() => json({ tier: "free", can_use_instant_voice_cloning: false, character_count: 9000, character_limit: 10000 }));
    const caps = await new ElevenLabsVoiceProvider(cfg, fn).capabilities();
    assert.equal(calls[0]!.url, "https://api.elevenlabs.io/v1/user/subscription");
    assert.equal(caps.canClone, false);
    assert.ok(Math.abs((caps.quotaRemaining ?? 0) - 0.1) < 1e-9);
  });

  it("adds a shared library voice via /v1/voices/add/{public_user_id}/{voice_id}", async () => {
    const { fn, calls } = mockFetch(() => json({ voice_id: "copied" }));
    const id = await new ElevenLabsVoiceProvider(cfg, fn).addLibraryVoice("owner 1", "lib1", "Narrator");
    assert.equal(id, "copied");
    assert.equal(calls[0]!.url, "https://api.elevenlabs.io/v1/voices/add/owner%201/lib1");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { new_name: "Narrator" });
  });

  it("treats deleting an already-missing voice as success", async () => {
    const { fn } = mockFetch(() => json({ detail: { status: "voice_not_found", message: "nope" } }, 404));
    await new ElevenLabsVoiceProvider(cfg, fn).deleteVoice("gone");
  });

  it("turns network failures into a retryable error", async () => {
    const fn = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(new ElevenLabsVoiceProvider(cfg, fn).synthesize({ providerVoiceId: "v", text: "x", speed: 1 }), (e: unknown) => {
      assert.ok(e instanceof AppError);
      assert.equal(e.code, "VOICE_UNAVAILABLE");
      assert.equal(e.retryable, true);
      return true;
    });
  });

  it("rejects an empty audio response", async () => {
    const { fn } = mockFetch(() => new Response(new Uint8Array([]), { status: 200 }));
    await assert.rejects(new ElevenLabsVoiceProvider(cfg, fn).synthesize({ providerVoiceId: "v", text: "x", speed: 1 }), /empty audio/);
  });
});

describe("ElevenLabs error mapping", () => {
  const body = (status: string, message = "m") => JSON.stringify({ detail: { status, message } });

  const cases: Array<[number, string, "speech" | "clone" | "voices" | "delete", string, number]> = [
    [401, body("invalid_api_key"), "speech", "VOICE_CONFIG", 503],
    [401, body("quota_exceeded"), "speech", "VOICE_QUOTA", 402],
    [400, body("max_character_limit_exceeded"), "speech", "TEXT_TOO_LONG", 413],
    [400, body("voice_not_found"), "speech", "VOICE_NOT_FOUND", 409],
    [404, "", "speech", "VOICE_NOT_FOUND", 409],
    [400, body("voice_limit_reached"), "clone", "VOICE_SLOTS_FULL", 409],
    [401, body("detected_unusual_activity"), "speech", "VOICE_BLOCKED", 403],
    [403, body("subscription_required"), "clone", "VOICE_CLONE_UNAVAILABLE", 402],
    [403, body("missing_permissions"), "speech", "VOICE_CONFIG", 503],
    [429, body("too_many_concurrent_requests"), "speech", "VOICE_BUSY", 429],
    [422, JSON.stringify({ detail: [{ loc: ["body", "files"], msg: "bad audio", type: "x" }] }), "clone", "VOICE_INVALID_AUDIO", 422],
    [500, "oops", "speech", "VOICE_UNAVAILABLE", 502],
    [503, "", "speech", "VOICE_UNAVAILABLE", 502],
  ];

  for (const [http, text, action, code, status] of cases) {
    it(`${http} ${text.slice(0, 40) || "(empty)"} during ${action} -> ${code}`, () => {
      const err = mapElevenLabsError(http, text, action);
      assert.equal(err.code, code);
      assert.equal(err.status, status);
      assert.ok(err.message.length > 20, "message is human-readable");
      assert.ok(!err.message.includes("xi-api-key"));
    });
  }

  it("keeps provider detail for operators but out of the main message", () => {
    const err = mapElevenLabsError(401, body("quota_exceeded", "You have 0 credits left"), "speech");
    assert.match(err.detail ?? "", /0 credits left/);
    assert.doesNotMatch(err.message, /0 credits left/);
  });
});
