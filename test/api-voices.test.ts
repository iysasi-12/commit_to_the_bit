import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { AppError } from "../server/errors.ts";
import { PREVIEW_TEXT } from "../server/services/voices.ts";
import { audioFilesFor, signedInUser, startHarness, type Harness } from "./helpers.ts";

function cloneForm(opts: { consent?: boolean; bytes?: number; type?: string; filename?: string; keep?: boolean; name?: string } = {}) {
  const form = new FormData();
  form.append("name", opts.name ?? "My voice");
  form.append("consentOwnVoice", String(opts.consent ?? true));
  form.append("consentProcessing", String(opts.consent ?? true));
  form.append("removeNoise", "false");
  form.append("keepRecording", String(opts.keep ?? false));
  const data = new Uint8Array(opts.bytes ?? 64 * 1024).fill(7);
  form.append("audio", new Blob([data], { type: opts.type ?? "audio/webm" }), opts.filename ?? "recording.webm");
  return form;
}

describe("voices: ready-made, library and the person's own clone", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({ limits: { cloneMaxFileBytes: 512 * 1024 } });
  });
  after(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.deps.limiter.reset();
    h.voice.canClone = true;
    h.voice.deleteFail = null;
  });

  it("lets people pick only offered ready-made voices", async () => {
    const { client } = await signedInUser(h, "picker");
    const list = await client.get("/api/voices");
    assert.deepEqual(
      list.body.stock.map((v: { providerVoiceId: string }) => v.providerVoiceId),
      ["stock-a", "stock-b"],
    );
    assert.equal(list.body.selected.ref, "stock:stock-a");
    assert.equal((await client.put("/api/voices/selected", { ref: "stock:stock-b" })).status, 200);
    const s = await client.post("/api/summaries", { scope: "many" });
    await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    assert.equal(h.voice.synthCalls.at(-1)!.providerVoiceId, "stock-b");

    const sneaky = await client.put("/api/voices/selected", { ref: "stock:someone-elses-clone" });
    assert.equal(sneaky.status, 403, "arbitrary provider voice ids are refused");
    assert.equal((await client.put("/api/voices/selected", { ref: "raw-id" })).status, 400);
  });

  it("re-voices a summary when the voice changes, and caches per voice", async () => {
    const { client } = await signedInUser(h, "switcher");
    const s = await client.post("/api/summaries", { scope: "many" });
    const a1 = await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    await client.put("/api/voices/selected", { ref: "stock:stock-b" });
    const a2 = await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    assert.notEqual(a1.body.audio.id, a2.body.audio.id);
    assert.equal(a2.body.audio.voiceName, "Ben");
    await client.put("/api/voices/selected", { ref: "stock:stock-a" });
    const a3 = await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    assert.equal(a3.body.cached, true);
    assert.equal(a3.body.audio.id, a1.body.audio.id);
  });

  it("re-voices when speaking speed changes", async () => {
    const { client } = await signedInUser(h, "speedy");
    const s = await client.post("/api/summaries", { scope: "many" });
    await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    await client.patch("/api/settings", { speakingSpeed: 1.15 });
    const a = await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    assert.equal(a.body.cached, false);
    assert.equal(h.voice.synthCalls.at(-1)!.speed, 1.15);
  });

  it("creates an own voice only with consent, valid audio and a plan that allows cloning", async () => {
    const { client } = await signedInUser(h, "cloner");
    const noConsent = await client.request("POST", "/api/voices/clone", { form: cloneForm({ consent: false }) });
    assert.equal(noConsent.status, 400);
    assert.equal(noConsent.body.error.code, "CLONE_CONSENT_REQUIRED");

    const tooShort = await client.request("POST", "/api/voices/clone", { form: cloneForm({ bytes: 1000 }) });
    assert.equal(tooShort.status, 422);
    assert.equal(tooShort.body.error.code, "RECORDING_TOO_SHORT");

    const notAudio = await client.request("POST", "/api/voices/clone", { form: cloneForm({ type: "image/png", filename: "x.png" }) });
    assert.equal(notAudio.status, 415);

    const tooBig = await client.request("POST", "/api/voices/clone", { form: cloneForm({ bytes: 600 * 1024 }) });
    assert.equal(tooBig.status, 413);

    const noCsrf = await client.request("POST", "/api/voices/clone", { form: cloneForm(), csrf: false });
    assert.equal(noCsrf.status, 403);

    h.voice.canClone = false;
    const plan = await client.request("POST", "/api/voices/clone", { form: cloneForm() });
    assert.equal(plan.status, 402);
    assert.equal(plan.body.error.code, "VOICE_CLONE_UNAVAILABLE");
    assert.match(plan.body.error.message, /paid plan/);
    assert.equal(h.voice.cloneCalls.length, 0, "nothing uploaded to ElevenLabs on any rejected attempt");
  });

  it("runs the full own-voice flow: create, preview, approve, use, delete", async () => {
    const { client, userId } = await signedInUser(h, "mom");
    const created = await client.request("POST", "/api/voices/clone", { form: cloneForm({ name: "Mom" }) });
    assert.equal(created.status, 201);
    const voice = created.body.voice;
    assert.equal(voice.status, "preview");
    assert.equal(voice.recordingKept, false);
    assert.equal(h.voice.cloneCalls.length, 1);
    assert.equal(h.voice.cloneCalls[0]!.files[0]!.buffer.length, 64 * 1024);
    assert.equal(fs.existsSync(path.join(h.dataDir, "recordings", userId)), false, "recording not kept by default");

    const s = await client.post("/api/summaries", { scope: "many" });
    const beforeApprove = await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    assert.equal(beforeApprove.body.audio.voiceName, "Aria", "an unapproved clone isn't used for summaries");
    assert.equal((await client.put("/api/voices/selected", { ref: voice.ref })).status, 409);

    const preview = await client.post(`/api/voices/${voice.id}/preview`);
    assert.equal(preview.status, 200);
    assert.equal(h.voice.synthCalls.at(-1)!.text, PREVIEW_TEXT, "previews only ever say the fixed sentence");
    assert.equal(h.voice.synthCalls.at(-1)!.providerVoiceId, "clone-1");

    const approved = await client.post(`/api/voices/${voice.id}/approve`);
    assert.equal(approved.body.voice.status, "approved");
    const list = await client.get("/api/voices");
    assert.equal(list.body.selected.ref, voice.ref);
    const mine = await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    assert.equal(mine.body.audio.voiceName, "Mom");
    assert.equal(mine.body.audio.voiceKind, "own");
    assert.equal(h.voice.synthCalls.at(-1)!.providerVoiceId, "clone-1");

    const second = await client.request("POST", "/api/voices/clone", { form: cloneForm() });
    assert.equal(second.status, 409, "one own voice at a time");

    const filesBefore = audioFilesFor(h, userId).length;
    assert.ok(filesBefore >= 3);
    const del = await client.del(`/api/voices/${voice.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.deletedAtProvider, true);
    assert.ok(h.voice.deleteCalls.includes("clone-1"), "deleted at ElevenLabs");
    assert.equal((await client.get(mine.body.audio.url)).status, 404, "cached audio in that voice is gone");
    assert.equal((await client.get(preview.body.audio.url)).status, 404);
    assert.equal(audioFilesFor(h, userId).length, filesBefore - 2, "only that voice's files were removed");
    const after = await client.get("/api/voices");
    assert.equal(after.body.selected.ref, "stock:stock-a", "falls back to a ready-made voice");
    const again = await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    assert.equal(again.body.audio.voiceName, "Aria");
  });

  it("keeps the recording only when asked, and can delete it", async () => {
    const { client, userId } = await signedInUser(h, "keeper");
    const created = await client.request("POST", "/api/voices/clone", { form: cloneForm({ keep: true }) });
    assert.equal(created.body.voice.recordingKept, true);
    const dir = path.join(h.dataDir, "recordings", userId);
    assert.equal(fs.readdirSync(dir).length, 1);
    await client.del(`/api/voices/${created.body.voice.id}/recording`);
    assert.equal(fs.readdirSync(dir).length, 0);
    const list = await client.get("/api/voices");
    assert.equal(list.body.mine[0].recordingKept, false);
  });

  it("keeps the voice if ElevenLabs can't delete it, and says so", async () => {
    const { client } = await signedInUser(h, "stuck");
    const created = await client.request("POST", "/api/voices/clone", { form: cloneForm() });
    h.voice.deleteFail = new AppError("VOICE_UNAVAILABLE", 502, "The voice service had a temporary problem.", { retryable: true });
    const del = await client.del(`/api/voices/${created.body.voice.id}`);
    assert.equal(del.status, 502);
    assert.equal(del.body.error.code, "VOICE_DELETE_FAILED");
    assert.equal(del.body.error.retryable, true);
    assert.equal((await client.get("/api/voices")).body.mine.length, 1, "nothing half-deleted");
    h.voice.deleteFail = null;
    assert.equal((await client.del(`/api/voices/${created.body.voice.id}`)).status, 200);
  });

  it("never lets one person use, preview, approve or delete another person's voice", async () => {
    const owner = await signedInUser(h, "owner");
    const other = await signedInUser(h, "intruder");
    const created = await owner.client.request("POST", "/api/voices/clone", { form: cloneForm({ name: "Owner" }) });
    const v = created.body.voice;
    await owner.client.post(`/api/voices/${v.id}/approve`);
    const synthBefore = h.voice.synthCalls.length;

    assert.equal((await other.client.put("/api/voices/selected", { ref: v.ref })).status, 404);
    assert.equal((await other.client.post(`/api/voices/${v.id}/preview`)).status, 404);
    assert.equal((await other.client.post(`/api/voices/${v.id}/approve`)).status, 404);
    assert.equal((await other.client.del(`/api/voices/${v.id}`)).status, 404);
    assert.equal((await other.client.del(`/api/voices/${v.id}/recording`)).status, 404);
    assert.equal((await other.client.put("/api/voices/selected", { ref: "stock:clone-1" })).status, 403, "provider id of a clone can't be smuggled in as a stock voice");
    const theirList = await other.client.get("/api/voices");
    assert.equal(theirList.body.mine.length, 0);
    assert.equal(h.voice.synthCalls.length, synthBefore, "no audio was generated in the owner's voice");
    assert.equal((await owner.client.get("/api/voices")).body.mine[0].status, "approved");
  });

  it("adds Voice Library voices, limits them, and removes them", async () => {
    const { client } = await signedInUser(h, "librarian");
    const search = await client.get("/api/voices/library?search=narr");
    assert.equal(search.body.voices[0].name, "Narrator");
    const add = await client.post("/api/voices/library", { publicOwnerId: "owner1", providerVoiceId: "libvoice1", name: "Narrator" });
    assert.equal(add.status, 201);
    assert.equal(add.body.voice.kind, "library");
    const list = await client.get("/api/voices");
    assert.equal(list.body.selected.ref, add.body.voice.ref, "added voice is selected");
    const s = await client.post("/api/summaries", { scope: "many" });
    await client.post(`/api/summaries/${s.body.summary.id}/audio`);
    assert.equal(h.voice.synthCalls.at(-1)!.providerVoiceId, "added-libvoice1");
    const bad = await client.post("/api/voices/library", { publicOwnerId: "../x", providerVoiceId: "y", name: "z" });
    assert.equal(bad.status, 400);
    for (let i = 0; i < 4; i++) await client.post("/api/voices/library", { publicOwnerId: "owner1", providerVoiceId: `lib${i}`, name: `L${i}` });
    const sixth = await client.post("/api/voices/library", { publicOwnerId: "owner1", providerVoiceId: "lib9", name: "L9" });
    assert.equal(sixth.status, 409);
    assert.equal((await client.del(`/api/voices/${add.body.voice.id}`)).status, 200);
  });

  it("deleting the account deletes the clone at ElevenLabs", async () => {
    const { client } = await signedInUser(h, "leaving");
    const created = await client.request("POST", "/api/voices/clone", { form: cloneForm() });
    const providerId = h.voice.cloneCalls.length ? `clone-${h.voice.cloneCalls.length}` : "";
    assert.equal(created.status, 201);
    const res = await client.del("/api/account");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.voicesNotDeleted, []);
    assert.ok(h.voice.deleteCalls.includes(providerId));
  });

  it("reports clone capability", async () => {
    const { client } = await signedInUser(h, "capcheck");
    assert.deepEqual((await client.get("/api/voices/capabilities")).body, { mode: "live", canClone: true, message: null });
    h.voice.canClone = false;
    const off = await client.get("/api/voices/capabilities");
    assert.equal(off.body.canClone, false);
    assert.match(off.body.message, /paid plan/);
  });
});
