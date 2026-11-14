"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { reconnectGoogle, signOutAction } from "@/app/actions";
import { VoiceBox } from "@/components/VoiceBox";
import { DEFAULT_VOICE, readError, storageGet, storageSet, type ActiveVoice, type QueueItem } from "@/components/types";

const CATEGORY_LABEL: Record<QueueItem["category"], string> = { work: "Work / School", personal: "Personal", transactions: "Transactions" };
const CATEGORY_STYLE: Record<QueueItem["category"], string> = {
  work: "bg-sky-500/20 text-sky-300",
  personal: "bg-amber-500/20 text-amber-300",
  transactions: "bg-emerald-500/20 text-emerald-300",
};

type PlayStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export function Dashboard({ name, email, sessionExpired }: { name: string; email: string; sessionExpired: boolean }) {
  const [voice, setVoice] = useState<ActiveVoice>(DEFAULT_VOICE);
  const [expired, setExpired] = useState(sessionExpired);
  const [count, setCount] = useState(10);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ fetched: number; spam: number; failed: number } | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<PlayStatus>("idle");
  const [playError, setPlayError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Audio already paid for, keyed by `${emailId}-${voiceId}`, so replays never call ElevenLabs again.
  const cache = useRef(new Map<string, string>());
  const playToken = useRef(0);

  useEffect(() => {
    const saved = storageGet<ActiveVoice | null>("via.voice", null);
    if (saved?.id) setVoice(saved);
  }, []);

  const selectVoice = useCallback((v: ActiveVoice) => {
    setVoice(v);
    storageSet("via.voice", v);
  }, []);

  const onAuthError = useCallback((code: string) => {
    if (code === "SESSION_EXPIRED" || code === "NOT_SIGNED_IN") setExpired(true);
  }, []);

  /** Fetches (or reuses) audio for one email and plays it. Called only for the email being listened to. */
  const playItem = useCallback(
    async (item: QueueItem) => {
      const token = ++playToken.current;
      const el = audioRef.current;
      if (!el) return;
      el.pause();
      setPlayError(null);
      if (!voice.id) {
        setStatus("error");
        setPlayError("Pick a voice in the Voice Box first.");
        return;
      }
      const key = `${item.id}-${voice.id}`;
      let url = cache.current.get(key);
      if (!url) {
        setStatus("loading");
        try {
          const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: item.summary, voiceId: voice.id }) });
          if (!res.ok) {
            const { message, code } = await readError(res);
            onAuthError(code);
            if (token === playToken.current) {
              setStatus("error");
              setPlayError(message);
            }
            return;
          }
          url = URL.createObjectURL(await res.blob());
          cache.current.set(key, url);
        } catch {
          if (token === playToken.current) {
            setStatus("error");
            setPlayError("Couldn't reach the server for audio. Check your connection.");
          }
          return;
        }
      }
      if (token !== playToken.current) return;
      el.src = url;
      el.currentTime = 0;
      try {
        await el.play();
      } catch {
        // Browsers can block audio that starts without a click; the Play button covers it.
        setStatus("paused");
      }
    },
    [voice.id, onAuthError],
  );

  async function scan() {
    setScanning(true);
    setScanError(null);
    setStats(null);
    setQueue([]);
    setIndex(0);
    setStatus("idle");
    audioRef.current?.pause();
    try {
      // Refresh the Google session cookie first (Auth.js rotates the token here if it expired).
      const session = (await fetch("/api/auth/session").then((r) => r.json()).catch(() => null)) as { error?: string } | null;
      if (session?.error === "RefreshTokenError") {
        setExpired(true);
        return;
      }
      const res = await fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count }) });
      if (!res.ok) {
        const { message, code } = await readError(res);
        onAuthError(code);
        setScanError(message);
        return;
      }
      const json = (await res.json()) as { queue: QueueItem[]; stats: { fetched: number; spam: number; failed: number } };
      setQueue(json.queue);
      setStats(json.stats);
      if (json.queue[0]) void playItem(json.queue[0]);
    } catch {
      setScanError("Couldn't reach the server. Check your connection.");
    } finally {
      setScanning(false);
    }
  }

  const current = queue[index];
  const atEnd = index >= queue.length - 1;

  function next() {
    if (atEnd) return;
    const i = index + 1;
    setIndex(i);
    void playItem(queue[i]!);
  }

  function skip() {
    if (atEnd) return;
    playToken.current++;
    audioRef.current?.pause();
    setIndex(index + 1);
    setStatus("idle");
    setPlayError(null);
  }

  function replay() {
    if (!current) return;
    const el = audioRef.current;
    if (el && cache.current.get(`${current.id}-${voice.id}`) && el.src === cache.current.get(`${current.id}-${voice.id}`)) {
      el.currentTime = 0;
      void el.play();
    } else {
      void playItem(current);
    }
  }

  function pauseResume() {
    const el = audioRef.current;
    if (!el) return;
    if (status === "playing") el.pause();
    else if (status === "paused") void el.play();
  }

  const btn = "rounded-xl px-4 py-3 font-semibold disabled:opacity-40";

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Voice Inbox Assistant</h1>
          <p className="text-sm text-slate-400">
            {name ? `${name} · ` : ""}
            {email}
          </p>
        </div>
        <form action={signOutAction}>
          <button className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800">Sign out</button>
        </form>
      </header>

      {expired && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/50 bg-amber-500/15 px-4 py-3" role="alert">
          <span className="text-amber-200">Your Google session expired or access was removed (Google limits apps in Testing mode to 7 days).</span>
          <form action={reconnectGoogle}>
            <button className="rounded-lg bg-amber-400 px-4 py-2 font-semibold text-slate-900 hover:bg-amber-300">Session Expired — Sign Out &amp; Reconnect Google</button>
          </form>
        </div>
      )}

      <VoiceBox active={voice} onSelect={selectVoice} onAuthError={onAuthError} />

      <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-5" aria-labelledby="scan-h">
        <h2 id="scan-h" className="sr-only">
          Scan inbox
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-semibold">
            Recent emails
            <select className="ml-2 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2" value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={scanning}>
              {[5, 10, 15, 20, 25, 30].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button className={`${btn} bg-indigo-500 text-white hover:bg-indigo-400`} onClick={() => void scan()} disabled={scanning || expired}>
            {scanning ? "Reading and summarizing…" : "Scan & Summarize Inbox"}
          </button>
        </div>
        {scanError && (
          <p className="mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300" role="alert">
            {scanError}
          </p>
        )}
        {stats && (
          <p className="mt-3 text-sm text-slate-400">
            Read {stats.fetched} emails · {queue.length} to hear · {stats.spam} spam skipped{stats.failed ? ` · ${stats.failed} couldn't be summarized` : ""}
          </p>
        )}
      </section>

      {stats && queue.length === 0 && <p className="rounded-xl bg-slate-800 px-4 py-3">Nothing to hear: every email was spam or couldn&apos;t be summarized.</p>}

      {current && (
        <section className="rounded-2xl border border-indigo-400/40 bg-slate-900 p-6 shadow-xl" aria-labelledby="player-h" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="player-h" className="text-lg font-bold">
              Email {index + 1} of {queue.length}
            </h2>
            <span className={`rounded-full px-3 py-1 text-sm font-semibold ${CATEGORY_STYLE[current.category]}`}>{CATEGORY_LABEL[current.category]}</span>
          </div>
          <div className="mt-3 text-sm text-slate-400">
            <div className="truncate">From: {current.from}</div>
            <div className="truncate">Subject: {current.subject}</div>
          </div>
          <p className="mt-4 whitespace-pre-line text-lg leading-relaxed">{current.summary}</p>
          <p className="mt-2 text-xs text-slate-500">AI-generated summary read by an AI voice ({voice.label || "no voice"}).</p>

          <div className="mt-5 text-sm text-slate-300" role="status">
            {status === "loading" && "Generating audio…"}
            {status === "playing" && "Playing"}
            {status === "paused" && "Paused"}
            {status === "ended" && (atEnd ? "Finished. That was your last email." : "Finished. Click Next Email when you're ready.")}
            {status === "idle" && "Not played yet. Click Listen to hear it."}
            {status === "error" && <span className="text-red-300">{playError}</span>}
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            {status === "idle" || status === "error" ? (
              <button className={`${btn} bg-indigo-500 text-white hover:bg-indigo-400`} onClick={() => void playItem(current)}>
                ▶ Listen
              </button>
            ) : (
              <button className={`${btn} bg-slate-700 hover:bg-slate-600`} onClick={pauseResume} disabled={status === "loading" || status === "ended"}>
                {status === "playing" ? "Pause" : "Resume"}
              </button>
            )}
            <button className={`${btn} bg-slate-700 hover:bg-slate-600`} onClick={replay} disabled={status === "loading"}>
              Replay
            </button>
            <button className={`${btn} bg-slate-700 hover:bg-slate-600`} onClick={skip} disabled={atEnd}>
              Skip
            </button>
            <button className={`${btn} bg-indigo-500 text-white hover:bg-indigo-400`} onClick={next} disabled={atEnd || status === "loading"}>
              Next Email →
            </button>
          </div>
        </section>
      )}

      <audio
        ref={audioRef}
        onPlay={() => setStatus("playing")}
        onPause={(e) => {
          if (!e.currentTarget.ended) setStatus((s) => (s === "loading" ? s : "paused"));
        }}
        // Never auto-advance: wait for Next Email.
        onEnded={() => setStatus("ended")}
        onError={() => {
          if (audioRef.current?.getAttribute("src")) {
            setStatus("error");
            setPlayError("The audio couldn't be played. Try Replay.");
          }
        }}
      />
    </main>
  );
}
