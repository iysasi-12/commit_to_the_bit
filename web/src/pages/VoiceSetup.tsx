import { useEffect, useRef, useState } from "react";
import { api, errorMessage, uploadForm } from "../api.ts";
import { Icon } from "../icons.tsx";
import { useApp } from "../state.tsx";
import type { AudioInfo, MyVoice } from "../types.ts";
import { clock } from "../util.ts";

export const RECORDING_SCRIPT = `Hi, it's me. I'm recording this so my email summaries can be read in my own voice. I'll speak the way I normally talk, nice and relaxed.

This morning I made a cup of coffee, checked the weather, and looked at my calendar. There's a meeting at ten thirty, a dentist appointment on Thursday, and a birthday dinner on Saturday night. I still need to pay the electric bill, which is due on the fifteenth, and I want to remember to call Grandma back.

Some emails are important, like a note from a teacher or a message from work. Others are just sales and newsletters, and those can usually wait. A quick summary helps me focus on what matters.

Let me try a few questions and numbers. Did the package arrive yet? Is practice still at four fifteen? The total came to forty-two dollars and eighty cents.

Thanks for listening. That's all for now. Have a wonderful day, and talk to you soon.`;

const MIN_SECONDS = 30;
const TARGET_MIN = 60;
const TARGET_MAX = 120;
const AUTO_STOP = 180;

type Step = "consent" | "record" | "creating" | "preview" | "done";

interface Take {
  blob: Blob;
  url: string;
  seconds: number | null;
  fileName: string;
  source: "mic" | "file";
}

function pickMime(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  const options = [
    { mime: "audio/webm;codecs=opus", ext: "webm" },
    { mime: "audio/webm", ext: "webm" },
    { mime: "audio/mp4", ext: "m4a" },
    { mime: "audio/ogg;codecs=opus", ext: "ogg" },
  ];
  return options.find((o) => MediaRecorder.isTypeSupported(o.mime)) ?? { mime: "", ext: "webm" };
}

function lengthHint(seconds: number): { text: string; tone: "warn" | "ok" } {
  if (seconds < MIN_SECONDS) return { text: `Keep going: at least ${MIN_SECONDS} seconds is needed, 1 to 2 minutes is best.`, tone: "warn" };
  if (seconds < TARGET_MIN) return { text: "That works. A little more (up to 2 minutes) usually sounds more like you.", tone: "ok" };
  if (seconds <= TARGET_MAX) return { text: "Great length.", tone: "ok" };
  return { text: "Plenty. More than about 3 minutes doesn't improve the voice.", tone: "ok" };
}

function Steps({ step }: { step: Step }) {
  const order: Step[] = ["consent", "record", "creating", "preview"];
  const idx = step === "done" ? order.length : order.indexOf(step);
  return (
    <div className="steps" aria-hidden="true">
      {order.map((s, i) => (
        <span key={s} className={i <= idx ? "on" : ""} />
      ))}
    </div>
  );
}

export function VoiceSetup({ existing, onClose, onChanged }: { existing: MyVoice | null; onClose: () => void; onChanged: () => void }) {
  const { me, config } = useApp();
  const [step, setStep] = useState<Step>(existing?.status === "preview" ? "preview" : "consent");
  const [caps, setCaps] = useState<{ canClone: boolean; message: string | null; mode: string } | null>(null);
  const [voiceName, setVoiceName] = useState(`${me.name}'s voice`);
  const [ownVoice, setOwnVoice] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [usage, setUsage] = useState(false);
  const [removeNoise, setRemoveNoise] = useState(false);
  const [keepRecording, setKeepRecording] = useState(false);
  const [take, setTake] = useState<Take | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState(0);
  const [voice, setVoice] = useState<MyVoice | null>(existing);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "playing">("idle");

  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const previewEl = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    api<{ canClone: boolean; message: string | null; mode: string }>("/api/voices/capabilities").then(setCaps, (err) =>
      setCaps({ canClone: false, message: errorMessage(err), mode: "unavailable" }),
    );
    return () => {
      stopTracks();
      if (take) URL.revokeObjectURL(take.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopTracks() {
    if (timer.current) window.clearInterval(timer.current);
    if (raf.current) cancelAnimationFrame(raf.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtx.current?.close().catch(() => undefined);
    audioCtx.current = null;
  }

  async function startRecording() {
    setError(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError("Microphone recording needs a secure page (https:// or localhost). You can upload an audio file instead.");
      return;
    }
    const fmt = pickMime();
    if (!fmt) {
      setError("This browser can't record audio. Upload an audio file instead.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setError(
        name === "NotAllowedError"
          ? "Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again."
          : name === "NotFoundError"
            ? "No microphone was found. Plug one in or upload a recording instead."
            : "Couldn't start the microphone. Try again or upload a recording instead.",
      );
      return;
    }
    streamRef.current = stream;
    if (take) URL.revokeObjectURL(take.url);
    setTake(null);
    chunks.current = [];
    const rec = new MediaRecorder(stream, fmt.mime ? { mimeType: fmt.mime } : undefined);
    recRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      const type = rec.mimeType || fmt.mime || "audio/webm";
      const blob = new Blob(chunks.current, { type });
      const seconds = (Date.now() - startedAt.current) / 1000;
      const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      setTake({ blob, url: URL.createObjectURL(blob), seconds, fileName: `recording.${ext}`, source: "mic" });
      setRecording(false);
      stopTracks();
    };
    startedAt.current = Date.now();
    setElapsed(0);
    rec.start(1000);
    setRecording(true);
    timer.current = window.setInterval(() => {
      const s = (Date.now() - startedAt.current) / 1000;
      setElapsed(s);
      if (s >= AUTO_STOP && rec.state === "recording") rec.stop();
    }, 250);
    try {
      const ctx = new AudioContext();
      audioCtx.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 90));
        raf.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // The level meter is optional.
    }
  }

  function stopRecording() {
    if (recRef.current?.state === "recording") recRef.current.stop();
  }

  function onFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (file.size > config.limits.cloneMaxFileMb * 1024 * 1024) {
      setError(`That file is over ${config.limits.cloneMaxFileMb} MB. Trim it to about 2 minutes or export it as MP3.`);
      return;
    }
    if (take) URL.revokeObjectURL(take.url);
    const url = URL.createObjectURL(file);
    const probe = new Audio();
    probe.preload = "metadata";
    probe.onloadedmetadata = () => setTake((t) => (t && t.url === url ? { ...t, seconds: Number.isFinite(probe.duration) ? probe.duration : null } : t));
    probe.src = url;
    setTake({ blob: file, url, seconds: null, fileName: file.name || "upload.mp3", source: "file" });
  }

  async function createVoice() {
    if (!take) return;
    setError(null);
    setStep("creating");
    setUploadPct(0);
    const form = new FormData();
    form.append("name", voiceName.trim());
    form.append("consentOwnVoice", String(ownVoice));
    form.append("consentProcessing", String(processing));
    form.append("removeNoise", String(removeNoise));
    form.append("keepRecording", String(keepRecording));
    form.append("audio", take.blob, take.fileName);
    try {
      const res = await uploadForm<{ voice: MyVoice }>("/api/voices/clone", form, setUploadPct);
      setVoice(res.voice);
      setStep("preview");
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
      setStep("record");
    }
  }

  async function playPreview() {
    if (!voice) return;
    setError(null);
    setPreviewState("loading");
    try {
      const res = await api<{ audio: AudioInfo }>(`/api/voices/${voice.id}/preview`, { method: "POST" });
      const el = previewEl.current ?? new Audio();
      previewEl.current = el;
      el.src = res.audio.url;
      el.onended = () => setPreviewState("idle");
      await el.play();
      setPreviewState("playing");
    } catch (err) {
      setError(errorMessage(err));
      setPreviewState("idle");
    }
  }

  async function approve() {
    if (!voice) return;
    setError(null);
    try {
      await api(`/api/voices/${voice.id}/approve`, { method: "POST" });
      previewEl.current?.pause();
      setStep("done");
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function redo() {
    if (!voice) return;
    setError(null);
    try {
      previewEl.current?.pause();
      await api(`/api/voices/${voice.id}`, { method: "DELETE" });
      setVoice(null);
      if (take) URL.revokeObjectURL(take.url);
      setTake(null);
      onChanged();
      setStep(ownVoice && processing && usage ? "record" : "consent");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const consentOk = ownVoice && processing && usage && voiceName.trim().length > 0;
  const tooShort = take?.seconds != null && take.seconds < MIN_SECONDS;
  const hint = recording ? lengthHint(elapsed) : take?.seconds != null ? lengthHint(take.seconds) : null;

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="sheet">
        <div className="sheet-head">
          <h2 id="setup-title">Create your own voice</h2>
          <button
            className="icon-btn"
            onClick={() => {
              stopRecording();
              onClose();
            }}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </div>
        <Steps step={step} />

        {caps && !caps.canClone && step !== "preview" && step !== "done" && (
          <div className="notice notice-warn" style={{ marginBottom: 12 }}>
            <strong>Voice cloning isn't available right now</strong>
            {caps.message}
          </div>
        )}
        {caps?.mode === "demo" && (
          <div className="notice notice-warn" style={{ marginBottom: 12 }}>
            Demo mode: no ElevenLabs key is set, so no real voice is created and previews are placeholder tones.
          </div>
        )}

        {step === "consent" && (
          <div className="stack">
            <p>
              Record 1 to 2 minutes of yourself reading a short script. ElevenLabs uses it to make an AI copy of your voice (an Instant Voice Clone) that reads your
              email summaries to you. Only you can use it in this app.
            </p>
            <label className="field">
              Voice name
              <input className="input" value={voiceName} maxLength={40} onChange={(e) => setVoiceName(e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={ownVoice} onChange={(e) => setOwnVoice(e.target.checked)} />
              <span>This is my own voice. I won't upload anyone else's voice.</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={processing} onChange={(e) => setProcessing(e.target.checked)} />
              <span>I agree to my recording being sent to ElevenLabs to create a voice clone, under ElevenLabs' terms.</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={usage} onChange={(e) => setUsage(e.target.checked)} />
              <span>I understand the clone is used only to read my own email summaries, that its audio is AI-generated, and that I can delete it any time.</span>
            </label>
            <button className="btn btn-primary btn-lg" disabled={!consentOk || caps?.canClone === false} onClick={() => setStep("record")}>
              Continue
            </button>
          </div>
        )}

        {step === "record" && (
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>
              Find a quiet room, hold the phone about a hand's width away, and read naturally. Pauses and small mistakes are fine.
            </p>
            <div className="script" tabIndex={0} aria-label="Recording script">
              {RECORDING_SCRIPT.split("\n\n").map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>

            <div className="rec-panel">
              <div className="rec-time" aria-live="off">
                {clock(recording ? elapsed : (take?.seconds ?? 0))}
              </div>
              <button
                className={`rec-button${recording ? " recording" : ""}`}
                onClick={recording ? stopRecording : startRecording}
                aria-label={recording ? "Stop recording" : take ? "Record again" : "Start recording"}
              >
                <Icon name={recording ? "stop" : "mic"} />
              </button>
              {recording && (
                <div className="meter" aria-hidden="true">
                  <div style={{ width: `${Math.round(level * 100)}%` }} />
                </div>
              )}
              <div className="small muted">{recording ? "Recording… tap to stop" : take ? "Tap to record again" : "Tap to start recording"}</div>
              {hint && (
                <div className={`notice small ${hint.tone === "warn" ? "notice-warn" : "notice-ok"}`} role="status">
                  {hint.text}
                </div>
              )}
            </div>

            {take && !recording && (
              <div className="card stack">
                <div className="row">
                  <strong>{take.source === "mic" ? "Your recording" : take.fileName}</strong>
                  <span className="spacer" />
                  <span className="small muted">{take.seconds != null ? clock(take.seconds) : "length unknown"}</span>
                </div>
                <audio controls src={take.url} style={{ width: "100%" }} />
              </div>
            )}

            <label className="btn btn-sm" style={{ alignSelf: "flex-start" }}>
              <Icon name="upload" /> Upload an audio file instead
              <input type="file" accept="audio/*,.mp3,.wav,.m4a,.webm,.ogg,.flac" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>

            <label className="check">
              <input type="checkbox" checked={removeNoise} onChange={(e) => setRemoveNoise(e.target.checked)} />
              <span>
                Remove background noise <span className="small muted">(only if it's noisy; it can lower quality on clean recordings)</span>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={keepRecording} onChange={(e) => setKeepRecording(e.target.checked)} />
              <span>
                Keep my recording on this server <span className="small muted">(off: it's discarded as soon as the voice is created)</span>
              </span>
            </label>

            {error && (
              <div className="notice notice-error" role="alert">
                {error}
              </div>
            )}
            <button className="btn btn-primary btn-lg" disabled={!take || recording || tooShort || caps?.canClone === false} onClick={createVoice}>
              Create my voice
            </button>
          </div>
        )}

        {step === "creating" && (
          <div className="stack" role="status" aria-live="polite">
            <h3>{uploadPct < 1 ? `Uploading your recording… ${Math.round(uploadPct * 100)}%` : "Creating your voice with ElevenLabs…"}</h3>
            <div className={`progress${uploadPct >= 1 ? " indeterminate" : ""}`}>
              <div style={uploadPct < 1 ? { width: `${Math.round(uploadPct * 100)}%` } : undefined} />
            </div>
            <p className="small muted">This usually takes a few seconds. Keep this screen open.</p>
          </div>
        )}

        {step === "preview" && voice && (
          <div className="stack">
            <div className="notice notice-ok">
              <strong>Your voice is ready to preview</strong>
              Listen to a short sample. If it sounds like you, approve it. If not, record again in a quieter spot.
            </div>
            {voice.requiresVerification && (
              <div className="notice notice-warn">ElevenLabs flagged this voice for verification. It may not work until it's verified in the ElevenLabs account.</div>
            )}
            <button className="btn btn-lg" onClick={playPreview} disabled={previewState === "loading"}>
              <Icon name="play" /> {previewState === "loading" ? "Generating sample…" : previewState === "playing" ? "Playing sample" : "Play sample"}
            </button>
            <p className="small muted" style={{ margin: 0 }}>
              The sample says: "Hi! This is my AI voice. From now on, I'll read your email summaries to you." (AI-generated)
            </p>
            {error && (
              <div className="notice notice-error" role="alert">
                {error}
              </div>
            )}
            <div className="row">
              <button className="btn btn-primary btn-lg" onClick={approve}>
                <Icon name="check" /> Use this voice
              </button>
              <button className="btn btn-ghost" onClick={redo}>
                Delete and record again
              </button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="stack">
            <div className="notice notice-ok">
              <strong>All set</strong>
              Your summaries will now be read in your voice. You can switch voices or delete this one any time on the Voice tab.
            </div>
            <button className="btn btn-primary btn-lg" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
