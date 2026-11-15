"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readError, SAMPLE_LINE, storageGet, storageSet, type ActiveVoice, type VoiceOption } from "@/components/types";

const DEFAULT_DESIGN_TEXT =
  "Starting with Work and School. For Biology 204 with Doctor Elena Vance, Lab Report 4 on Cellular Respiration is due Monday, November 16th at 11:59 PM. Remember to attach your raw data tables.";

/** Choosing this voice also makes the summaries butler-style (see Dashboard). */
export const BUTLER_NAME = "The Butler";

type Tab = "voices" | "design" | "custom";

interface Props {
  active: ActiveVoice;
  onSelect: (v: ActiveVoice) => void;
  onAuthError: (code: string) => void;
}

// min-h-11 = 44px, the smallest comfortable touch target on phones.
const btn = "inline-flex min-h-11 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${btn} bg-indigo-500 text-white hover:bg-indigo-400`;
const ghost = `${btn} border border-slate-600 text-slate-200 hover:bg-slate-800`;
const input = "min-h-11 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-slate-100 placeholder:text-slate-500";
/** One voice row: name on its own line on phones, buttons beside it from 640px up. */
const rowClass = (selected: boolean) =>
  `flex flex-col gap-2 rounded-lg border px-3 py-2 sm:flex-row sm:items-center sm:gap-3 ${selected ? "border-indigo-400 bg-indigo-500/10" : "border-slate-700"}`;
/** Long names wrap instead of being cut off ("The Very Long Custom Voice Name" never becomes "T…"). */
const nameClass = "font-semibold [overflow-wrap:anywhere]";
const inUseBadge = <span className="shrink-0 rounded-full bg-indigo-500 px-2.5 py-0.5 text-xs font-bold text-white">In use</span>;

interface VoiceList {
  custom: VoiceOption[];
  presets: VoiceOption[];
  slots: { used: number; limit: number; canClone: boolean } | null;
  /** This person's own saved voices; limit is null for admins. */
  mine: { used: number; limit: number | null };
}

/** The account's voices, the error response, or null when the server can't be reached. */
async function requestVoices(): Promise<VoiceList | Response | null> {
  try {
    const res = await fetch("/api/voices");
    return res.ok ? ((await res.json()) as VoiceList) : res;
  } catch {
    return null;
  }
}

/**
 * Keeps the shown name equal to the voice really used: picks up a rename, and replaces a voice
 * that was deleted in ElevenLabs. Voice IDs pasted by hand aren't in the account list, so they stay.
 */
export function reconcileVoice(list: VoiceList): { pick?: ActiveVoice; notice?: string } {
  const saved = storageGet<ActiveVoice | null>("via.voice", null);
  const first = list.presets[0];
  const fallback = first ? { id: first.voice_id, label: first.name } : undefined;
  if (!saved?.id) return { pick: fallback };
  const match = [...list.custom, ...list.presets].find((v) => v.voice_id === saved.id);
  if (match) return match.name === saved.label ? {} : { pick: { id: match.voice_id, label: match.name } };
  const pasted = storageGet<ActiveVoice[]>("via.pastedVoices", []);
  if (pasted.some((p) => p.id === saved.id) || !fallback) return {};
  return { pick: fallback, notice: `"${saved.label}" is no longer in your ElevenLabs voices, so ${fallback.label} will read instead.` };
}

export function VoiceBox({ active, onSelect, onAuthError }: Props) {
  const [tab, setTab] = useState<Tab>("voices");
  const [custom, setCustom] = useState<VoiceOption[]>([]);
  const [presets, setPresets] = useState<VoiceOption[]>([]);
  // Read once on the client. Safe for hydration: the list only renders after voices finish loading.
  const [pasted, setPasted] = useState<ActiveVoice[]>(() => storageGet<ActiveVoice[]>("via.pastedVoices", []));
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
  const [cloneUrl, setCloneUrl] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [removeNoise, setRemoveNoise] = useState(false);
  const [slots, setSlots] = useState<{ used: number; limit: number; canClone: boolean } | null>(null);
  const [mine, setMine] = useState<VoiceList["mine"] | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);

  const fail = useCallback(
    async (res: Response) => {
      const { message, code } = await readError(res);
      if (code === "SESSION_EXPIRED" || code === "NOT_SIGNED_IN") onAuthError(code);
      setError(message);
    },
    [onAuthError],
  );

  function setTake(file: File) {
    if (cloneUrl) URL.revokeObjectURL(cloneUrl);
    setCloneFile(file);
    setCloneUrl(URL.createObjectURL(file));
  }

  async function startRecording() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) return setError("This browser can't record here. Upload an audio file instead.");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return setError("Microphone access was blocked. Allow the microphone for this site, or upload a file instead.");
    }
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (timer.current) window.clearInterval(timer.current);
      const type = rec.mimeType || mime || "audio/webm";
      const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      setTake(new File([new Blob(chunks.current, { type })], `recording.${ext}`, { type }));
      setRecording(false);
    };
    recorder.current = rec;
    rec.start(1000);
    setSeconds(0);
    setRecording(true);
    const started = Date.now();
    timer.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= 180 && rec.state === "recording") rec.stop(); // more than 3 minutes doesn't help
    }, 250);
  }

  function stopRecording() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  /** Applies a voice-list response to the screen. */
  const applyVoices = useCallback(
    (result: VoiceList | Response | null) => {
      setLoading(false);
      if (result === null) return setError("Couldn't load voices. Check your connection.");
      if (result instanceof Response) return void fail(result);
      setSlots(result.slots);
      setMine(result.mine ?? null);
      setCustom(result.custom);
      setPresets(result.presets);
      const { pick, notice } = reconcileVoice(result);
      if (pick) onSelect(pick);
      if (notice) setNotice(notice);
    },
    [fail, onSelect],
  );

  // First load (`loading` already starts true). A reply that arrives after the box closes is ignored.
  useEffect(() => {
    let alive = true;
    void requestVoices().then((result) => alive && applyVoices(result));
    return () => {
      alive = false;
    };
  }, [applyVoices]);

  /** Reloads after a change (new, saved or deleted voice), showing the loading state meanwhile. */
  async function loadVoices() {
    setLoading(true);
    setError(null);
    applyVoices(await requestVoices());
  }

  async function removeVoice(id: string, name: string) {
    if (!window.confirm(`Delete "${name}" from your ElevenLabs account? This frees a voice slot and can't be undone.`)) return;
    setError(null);
    setBusy(`remove-${id}`);
    try {
      const res = await fetch(`/api/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) return void (await fail(res));
      setNotice(`Deleted "${name}".`);
      await loadVoices();
    } finally {
      setBusy(null);
    }
  }

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

  /** Adds The Butler to the account the first time (via Voice Design), then uses it like any voice. */
  async function addButler() {
    setError(null);
    setNotice(null);
    setBusy("butler");
    try {
      const res = await fetch("/api/voices/butler", { method: "POST" });
      if (!res.ok) return void (await fail(res));
      const json = (await res.json()) as { voice_id: string; name: string };
      onSelect({ id: json.voice_id, label: json.name });
      setNotice("The Butler is ready, sir. Summaries will now be read in his voice and style.");
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
    if (!cloneFile || !cloneName.trim()) return setError("Add a voice name and a recording (record one or upload a file).");
    if (!consent) return setError("Tick the box confirming it's your voice or you have permission.");
    setError(null);
    setNotice(null);
    setBusy("clone");
    try {
      const form = new FormData();
      form.append("name", cloneName.trim());
      form.append("consent", "true");
      form.append("removeNoise", String(removeNoise));
      form.append("files", cloneFile, cloneFile.name);
      const res = await fetch("/api/voices/clone", { method: "POST", body: form });
      if (!res.ok) return void (await fail(res));
      const json = (await res.json()) as { voice_id: string; name: string; requires_verification: boolean };
      onSelect({ id: json.voice_id, label: json.name });
      setNotice(
        json.requires_verification
          ? `Created "${json.name}", but ElevenLabs needs a quick verification before it can speak: go to elevenlabs.io → Voices → My Voices, open "${json.name}", and read the verification sentence aloud.` : `Cloned "${json.name}" and set it as your voice.`,
      );
      setCloneName("");
      setCloneFile(null);
      if (cloneUrl) URL.revokeObjectURL(cloneUrl);
      setCloneUrl(null);
      setConsent(false);
      setTab("voices");
      await loadVoices();
    } finally {
      setBusy(null);
    }
  }

  const voiceRow = (v: VoiceOption, removable = false) => {
    const selected = active.id === v.voice_id;
    const testing = busy === `test-${v.voice_id}`;
    const removing = busy === `remove-${v.voice_id}`;
    return (
      <li key={v.voice_id} className={rowClass(selected)} aria-current={selected ? "true" : undefined}>
        <div className="min-w-0 sm:flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={nameClass} title={v.name}>
              {v.name}
            </span>
            {selected && inUseBadge}
          </div>
          {v.description && (
            <div className="line-clamp-2 text-xs text-slate-400" title={v.description}>
              {v.description}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button className={ghost} onClick={() => void testVoice(v.voice_id, v.preview_url)} disabled={testing} aria-label={`Test ${v.name}`}>
            {testing ? "Loading…" : "Test Voice"}
          </button>
          {!selected && (
            <button className={primary} onClick={() => onSelect({ id: v.voice_id, label: v.name })} aria-label={`Use ${v.name}`}>
              Use
            </button>
          )}
          {removable && (
            <button className={ghost} onClick={() => void removeVoice(v.voice_id, v.name)} disabled={removing} aria-label={`Delete ${v.name}`}>
              {removing ? "Removing…" : "Remove"}
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-5" aria-labelledby="voicebox-h">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="voicebox-h" className="text-xl font-bold">
          Voice Box
        </h2>
        <div className="min-w-0 max-w-full text-sm text-slate-300" role="status">
          Reading with:{" "}
          <span className={`${nameClass} text-white`} title={active.label || undefined}>
            {active.label || (loading ? "loading voices…" : "no voice yet")}
          </span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist">
        {(
          [
            ["voices", "Preset & account voices"],
            ["design", "Design a voice"],
            ["custom", "Clone a voice"],
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
          {!loading && !custom.some((v) => v.name === BUTLER_NAME) && (
            <div className={rowClass(false)}>
              <div className="min-w-0 sm:flex-1">
                <div className={nameClass}>🎩 {BUTLER_NAME}</div>
                <div className="text-xs text-slate-400">A refined elderly British butler who calls you &ldquo;sir&rdquo;. Created in your ElevenLabs account the first time.</div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button className={primary} onClick={() => void addButler()} disabled={busy === "butler"}>
                  {busy === "butler" ? "Creating…" : "Add & Use"}
                </button>
              </div>
            </div>
          )}
          {!loading && custom.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">Your voices &amp; character voices</h3>
              <ul className="space-y-2">{custom.map((v) => voiceRow(v, Boolean(v.removable)))}</ul>
            </div>
          )}
          {!loading && pasted.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">Voice IDs you added</h3>
              <ul className="space-y-2">
                {pasted.map((p) => (
                  <li key={p.id} className={rowClass(active.id === p.id)} aria-current={active.id === p.id ? "true" : undefined}>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:flex-1">
                      <span className={nameClass} title={p.label}>
                        {p.label}
                      </span>
                      {active.id === p.id && inUseBadge}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <button className={ghost} onClick={() => void testVoice(p.id)} disabled={busy === `test-${p.id}`} aria-label={`Test ${p.label}`}>
                        {busy === `test-${p.id}` ? "Loading…" : "Test Voice"}
                      </button>
                      {active.id !== p.id && (
                        <button className={primary} onClick={() => onSelect(p)} aria-label={`Use ${p.label}`}>
                          Use
                        </button>
                      )}
                      <button className={ghost} onClick={() => removePasted(p.id)} aria-label={`Remove ${p.label} from this list`}>
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!loading && (
            <div>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">ElevenLabs presets</h3>
              <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">{presets.map((v) => voiceRow(v))}</ul>
            </div>
          )}
        </div>
      )}

      {tab === "design" && (
        <div className="mt-4 space-y-3">
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
            <h3 className="font-bold">Create a voice from a recording</h3>
            {(mine || slots) && (
              <p className={`text-sm ${(mine?.limit != null && mine.used >= mine.limit) || (slots && slots.used >= slots.limit) ? "font-semibold text-amber-300" : "text-slate-400"}`}>
                {mine && (mine.limit == null ? `You have ${mine.used} saved ${mine.used === 1 ? "voice" : "voices"}.` : `Your saved voices: ${mine.used} of ${mine.limit}.`)}
                {mine?.limit != null && mine.used >= mine.limit && " Remove one of yours before making another."}
                {slots && slots.used >= slots.limit && " The app's shared voice slots are full right now, so new voices can't be saved."}
                {slots && !slots.canClone && " The app's ElevenLabs plan doesn't include voice cloning."}
              </p>
            )}
            <input className={input} placeholder="Voice name (e.g. Mom)" value={cloneName} onChange={(e) => setCloneName(e.target.value)} />
            <details className="rounded-lg bg-slate-800/60 px-3 py-2 text-sm text-slate-300">
              <summary className="cursor-pointer font-semibold">Script to read (about 1 minute)</summary>
              <p className="mt-2 leading-relaxed">
                Hi, this is me recording my voice. This morning I checked the weather, made breakfast, and looked at my calendar. There&apos;s a meeting at ten thirty, a
                dentist appointment on Thursday, and dinner with friends on Saturday night. I still need to finish my lab report, which is due Monday at midnight. Some
                emails are important, and others are just sales and newsletters. Did the package arrive yet? The total came to forty-two dollars and eighty cents. Thanks
                for listening, and have a wonderful day.
              </p>
            </details>
            <div className="flex flex-wrap items-center gap-3">
              {recording ? (
                <button className={`${btn} bg-rose-500 text-white hover:bg-rose-400`} onClick={stopRecording}>
                  ■ Stop ({Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")})
                </button>
              ) : (
                <button className={primary} onClick={() => void startRecording()} disabled={busy === "clone"}>
                  ● {cloneFile ? "Record again" : "Record"}
                </button>
              )}
              <label className={`${ghost} cursor-pointer`}>
                Upload file
                <input
                  type="file"
                  accept="audio/*,.mp3,.wav,.m4a,.webm,.ogg,.flac"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setTake(f);
                  }}
                />
              </label>
            </div>
            {recording && <p className="text-xs text-slate-400">Speak naturally in a quiet room. 1 to 2 minutes works best; it stops by itself at 3 minutes.</p>}
            {cloneUrl && !recording && (
              <div className="space-y-1">
                <div className="text-xs text-slate-400">{cloneFile?.name}</div>
                <audio controls className="w-full" src={cloneUrl} />
              </div>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-indigo-500" checked={removeNoise} onChange={(e) => setRemoveNoise(e.target.checked)} />
              Remove background noise <span className="text-slate-400">(only if it&apos;s noisy)</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-indigo-500" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              This is my own voice, or I have the speaker&apos;s permission to clone it.
            </label>
            <button className={primary} onClick={() => void clone()} disabled={busy === "clone" || recording || !cloneFile || !cloneName.trim() || !consent}>
              {busy === "clone" ? "Creating voice…" : "Create voice"}
            </button>
            {(() => {
              // The most recent voice this person made (shared character voices aren't included).
              const last = custom
                .filter((v) => v.removable && (v.mine || v.category === "cloned"))
                .sort((a, b) => (b.created_at_unix ?? 0) - (a.created_at_unix ?? 0))[0];
              return last ? (
                <button className={`${ghost} w-full [overflow-wrap:anywhere]`} title={last.name} onClick={() => void removeVoice(last.voice_id, last.name)} disabled={busy === `remove-${last.voice_id}`}>
                  {busy === `remove-${last.voice_id}` ? "Removing…" : `Remove last voice made (${last.name})`}
                </button>
              ) : null;
            })()}
            <p className="text-xs text-slate-400">
              Uses ElevenLabs Instant Voice Cloning. The new voice is private to your Google account: other people using this app can&apos;t see, play, or remove it.
            </p>
          </div>
          <div className="space-y-3">
            <h3 className="font-bold">Or use an existing voice ID</h3>
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
        </div>
      )}
    </section>
  );
}
