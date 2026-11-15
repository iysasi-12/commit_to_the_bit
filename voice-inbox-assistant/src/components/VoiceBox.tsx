"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readError, SAMPLE_LINE, storageGet, storageSet, type ActiveVoice, type VoiceOption } from "@/components/types";

const DEFAULT_DESIGN_TEXT =
  "Starting with Work and School. For Biology 204 with Doctor Elena Vance, Lab Report 4 on Cellular Respiration is due Monday, November 16th at 11:59 PM. Remember to attach your raw data tables.";

// An original character voice for Butler mode (not modeled on any real actor).
const BUTLER_DESCRIPTION =
  "An elderly, distinguished English butler in his seventies with a warm, slightly gravelly, unhurried voice, crisp received pronunciation, and a gentle, dry wit.";
const BUTLER_PREVIEW_TEXT =
  "Starting with Work and School, sir. Your biology lab report is due Monday at 11:59 PM, sir, and Doctor Vance asks that you attach your raw data tables. I took the liberty of noting the deadline, sir.";

type Tab = "voices" | "design" | "custom";

interface Props {
  active: ActiveVoice;
  onSelect: (v: ActiveVoice) => void;
  onAuthError: (code: string) => void;
}

const btn = "rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50";
const primary = `${btn} bg-indigo-500 text-white hover:bg-indigo-400`;
const ghost = `${btn} border border-slate-600 text-slate-200 hover:bg-slate-800`;
const input = "w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-slate-100 placeholder:text-slate-500";

export function VoiceBox({ active, onSelect, onAuthError }: Props) {
  const [tab, setTab] = useState<Tab>("voices");
  const [custom, setCustom] = useState<VoiceOption[]>([]);
  const [presets, setPresets] = useState<VoiceOption[]>([]);
  const [pasted, setPasted] = useState<ActiveVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const sample = useRef<HTMLAudioElement | null>(null);

  // Voice Design
  const [description, setDescription] = useState("");
  const [designText, setDesignText] = useState(DEFAULT_DESIGN_TEXT);
  const [previews, setPreviews] = useState<Array<{ generated_voice_id: string; audio_base_64: string; media_type: string }>>([]);
  const [saveNames, setSaveNames] = useState<Record<string, string>>({});

  // Direct ID + clone
  const [idInput, setIdInput] = useState("");
  const [idLabel, setIdLabel] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [cloneFile, setCloneFile] = useState<File | null>(null);

  const fail = useCallback(
    async (res: Response) => {
      const { message, code } = await readError(res);
      if (code === "SESSION_EXPIRED" || code === "NOT_SIGNED_IN") onAuthError(code);
      setError(message);
    },
    [onAuthError],
  );

  const loadVoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/voices");
      if (!res.ok) return void (await fail(res));
      const json = (await res.json()) as { custom: VoiceOption[]; presets: VoiceOption[] };
      setCustom(json.custom);
      setPresets(json.presets);
      if (!storageGet<ActiveVoice | null>("via.voice", null) && json.presets[0]) {
        onSelect({ id: json.presets[0].voice_id, label: json.presets[0].name });
      }
    } catch {
      setError("Couldn't load voices. Check your connection.");
    } finally {
      setLoading(false);
    }
  }, [fail, onSelect]);

  useEffect(() => {
    setPasted(storageGet<ActiveVoice[]>("via.pastedVoices", []));
    void loadVoices();
  }, [loadVoices]);

  function playUrl(url: string) {
    sample.current?.pause();
    const a = new Audio(url);
    sample.current = a;
    void a.play().catch(() => setError("The browser blocked playback. Click again."));
  }

  /** Uses the voice's free preview clip when it has one; otherwise speaks one short sample line. */
  async function testVoice(id: string, previewUrl?: string | null) {
    setError(null);
    if (previewUrl) return playUrl(previewUrl);
    setBusy(`test-${id}`);
    try {
      const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: SAMPLE_LINE, voiceId: id }) });
      if (!res.ok) return void (await fail(res));
      playUrl(URL.createObjectURL(await res.blob()));
    } finally {
      setBusy(null);
    }
  }

  async function design() {
    setError(null);
    setNotice(null);
    setPreviews([]);
    setBusy("design");
    try {
      const res = await fetch("/api/voices/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceDescription: description, text: designText }),
      });
      if (!res.ok) return void (await fail(res));
      const json = (await res.json()) as { previews: Array<{ generated_voice_id: string; audio_base_64: string; media_type: string }> };
      setPreviews(json.previews);
      if (json.previews.length === 0) setError("ElevenLabs returned no previews. Try a different description.");
    } finally {
      setBusy(null);
    }
  }

  async function saveDesigned(generatedVoiceId: string) {
    const name = (saveNames[generatedVoiceId] ?? "").trim();
    if (!name) return setError("Give the voice a name before saving.");
    setError(null);
    setBusy(`save-${generatedVoiceId}`);
    try {
      const res = await fetch("/api/voices/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceName: name, voiceDescription: description, generatedVoiceId }),
      });
      if (!res.ok) return void (await fail(res));
      const json = (await res.json()) as { voice_id: string; name: string };
      onSelect({ id: json.voice_id, label: json.name });
      setNotice(`Saved "${json.name}" and set it as your voice.`);
      setPreviews([]);
      await loadVoices();
    } finally {
      setBusy(null);
    }
  }

  function addPasted() {
    const id = idInput.trim();
    if (!/^[A-Za-z0-9_-]{5,64}$/.test(id)) return setError("That doesn't look like an ElevenLabs voice ID.");
    const label = idLabel.trim() || `Voice ${id.slice(0, 6)}`;
    const next = [{ id, label }, ...pasted.filter((p) => p.id !== id)].slice(0, 20);
    setPasted(next);
    storageSet("via.pastedVoices", next);
    onSelect({ id, label });
    setIdInput("");
    setIdLabel("");
    setNotice(`"${label}" added and set as your voice.`);
  }

  function removePasted(id: string) {
    const next = pasted.filter((p) => p.id !== id);
    setPasted(next);
    storageSet("via.pastedVoices", next);
  }

  async function clone() {
    if (!cloneFile || !cloneName.trim()) return setError("Add a voice name and an .mp3 or .wav file.");
    setError(null);
    setNotice(null);
    setBusy("clone");
    try {
      const form = new FormData();
      form.append("name", cloneName.trim());
      form.append("files", cloneFile, cloneFile.name);
      const res = await fetch("/api/voices/clone", { method: "POST", body: form });
      if (!res.ok) return void (await fail(res));
      const json = (await res.json()) as { voice_id: string; name: string; requires_verification: boolean };
      onSelect({ id: json.voice_id, label: json.name });
      setNotice(
        json.requires_verification ? `Cloned "${json.name}". ElevenLabs says it needs verification before it can be used.` : `Cloned "${json.name}" and set it as your voice.`,
      );
      setCloneName("");
      setCloneFile(null);
      await loadVoices();
    } finally {
      setBusy(null);
    }
  }

  const voiceRow = (v: VoiceOption) => {
    const selected = active.id === v.voice_id;
    return (
      <li key={v.voice_id} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${selected ? "border-indigo-400 bg-indigo-500/10" : "border-slate-700"}`}>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{v.name}</div>
          {v.description && <div className="truncate text-xs text-slate-400">{v.description}</div>}
        </div>
        <button className={ghost} onClick={() => void testVoice(v.voice_id, v.preview_url)} disabled={busy === `test-${v.voice_id}`}>
          {busy === `test-${v.voice_id}` ? "…" : "Test Voice"}
        </button>
        {selected ? (
          <span className="rounded-full bg-indigo-500 px-3 py-1 text-xs font-bold">In use</span>
        ) : (
          <button className={primary} onClick={() => onSelect({ id: v.voice_id, label: v.name })}>
            Use
          </button>
        )}
      </li>
    );
  };

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-5" aria-labelledby="voicebox-h">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="voicebox-h" className="text-xl font-bold">
          Voice Box
        </h2>
        <div className="text-sm text-slate-300">
          Reading with: <span className="font-semibold text-white">{active.label || "no voice yet"}</span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist">
        {(
          [
            ["voices", "Preset & account voices"],
            ["design", "Design a voice"],
            ["custom", "Voice ID & clone"],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? primary : ghost} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mt-4 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-4 rounded-lg bg-emerald-500/15 px-3 py-2 text-sm text-emerald-300" role="status">
          {notice}
        </div>
      )}

      {tab === "voices" && (
        <div className="mt-4 space-y-5">
          {loading && <p className="text-slate-400">Loading voices…</p>}
          {!loading && custom.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">Saved custom voices</h3>
              <ul className="space-y-2">{custom.map(voiceRow)}</ul>
            </div>
          )}
          {!loading && pasted.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">Voice IDs you added</h3>
              <ul className="space-y-2">
                {pasted.map((p) => (
                  <li key={p.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${active.id === p.id ? "border-indigo-400 bg-indigo-500/10" : "border-slate-700"}`}>
                    <div className="min-w-0 flex-1 truncate font-semibold">{p.label}</div>
                    <button className={ghost} onClick={() => void testVoice(p.id)}>
                      Test Voice
                    </button>
                    {active.id === p.id ? (
                      <span className="rounded-full bg-indigo-500 px-3 py-1 text-xs font-bold">In use</span>
                    ) : (
                      <button className={primary} onClick={() => onSelect(p)}>
                        Use
                      </button>
                    )}
                    <button className={ghost} onClick={() => removePasted(p.id)} aria-label={`Remove ${p.label}`}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!loading && (
            <div>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">ElevenLabs presets</h3>
              <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">{presets.map(voiceRow)}</ul>
            </div>
          )}
        </div>
      )}

      {tab === "design" && (
        <div className="mt-4 space-y-3">
          <button
            className={ghost}
            onClick={() => {
              setDescription(BUTLER_DESCRIPTION);
              setDesignText(BUTLER_PREVIEW_TEXT);
              setSaveNames({});
            }}
          >
            🎩 Fill in the Butler voice
          </button>
          <label className="block text-sm font-semibold">
            Voice description <span className="font-normal text-slate-400">({description.trim().length}/1000, at least 20)</span>
            <textarea
              className={`${input} mt-1`}
              rows={2}
              maxLength={1000}
              placeholder="A calm, articulate British news anchor in his thirties"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="block text-sm font-semibold">
            Preview text <span className="font-normal text-slate-400">({designText.trim().length}/1000, at least 100)</span>
            <textarea className={`${input} mt-1`} rows={3} maxLength={1000} value={designText} onChange={(e) => setDesignText(e.target.value)} />
          </label>
          <button
            className={primary}
            onClick={() => void design()}
            disabled={busy === "design" || description.trim().length < 20 || designText.trim().length < 100}
          >
            {busy === "design" ? "Generating previews…" : "Generate Voice Previews"}
          </button>
          {previews.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-3">
              {previews.map((p, i) => (
                <li key={p.generated_voice_id} className="space-y-2 rounded-lg border border-slate-700 p-3">
                  <div className="text-sm font-semibold">Preview {i + 1}</div>
                  <audio controls className="w-full" src={`data:${p.media_type};base64,${p.audio_base_64}`} />
                  <input
                    className={input}
                    placeholder="Name this voice"
                    value={saveNames[p.generated_voice_id] ?? ""}
                    onChange={(e) => setSaveNames((s) => ({ ...s, [p.generated_voice_id]: e.target.value }))}
                  />
                  <button className={`${primary} w-full`} onClick={() => void saveDesigned(p.generated_voice_id)} disabled={busy === `save-${p.generated_voice_id}`}>
                    {busy === `save-${p.generated_voice_id}` ? "Saving…" : "Save & Use Voice"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "custom" && (
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div className="space-y-3">
            <h3 className="font-bold">Use a voice ID</h3>
            <input className={input} placeholder="ElevenLabs voice_id" value={idInput} onChange={(e) => setIdInput(e.target.value)} />
            <input className={input} placeholder="Label (e.g. Grandpa)" value={idLabel} onChange={(e) => setIdLabel(e.target.value)} />
            <div className="flex gap-2">
              <button className={ghost} onClick={() => void testVoice(idInput.trim())} disabled={!idInput.trim()}>
                Preview
              </button>
              <button className={primary} onClick={addPasted} disabled={!idInput.trim()}>
                Set as active voice
              </button>
            </div>
          </div>
          <div className="space-y-3">
            <h3 className="font-bold">Instant Voice Clone from a recording</h3>
            <input className={input} placeholder="Voice name" value={cloneName} onChange={(e) => setCloneName(e.target.value)} />
            <input
              type="file"
              accept=".mp3,.wav,audio/mpeg,audio/wav"
              className="block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:py-2 file:text-slate-100"
              onChange={(e) => setCloneFile(e.target.files?.[0] ?? null)}
            />
            <button className={primary} onClick={() => void clone()} disabled={busy === "clone" || !cloneFile || !cloneName.trim()}>
              {busy === "clone" ? "Cloning…" : "Clone voice"}
            </button>
            <p className="text-xs text-slate-400">
              Only clone your own voice or one you have permission to use. Instant Voice Cloning needs a paid ElevenLabs Starter or Creator plan; standard voices and Voice Design
              work on regular API keys. 1 to 2 minutes of clear speech works best.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
