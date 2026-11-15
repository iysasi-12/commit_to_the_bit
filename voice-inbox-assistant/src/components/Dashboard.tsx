"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reconnectGoogle, signOutAction } from "@/app/actions";
import { BUTLER_NAME, VoiceBox } from "@/components/VoiceBox";
import type { SummaryLength } from "@/lib/system-prompt";
import { composeSpoken } from "@/lib/triage";
import { DEFAULT_VOICE, readError, storageGet, storageSet, type ActiveVoice, type QueueItem } from "@/components/types";

/** Short hash of the spoken text, so audio made for "First, …" is never reused for "Finally, …". */
function textKey(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const audioKey = (id: string, voiceId: string, text: string) => `${id}-${voiceId}-${textKey(text)}`;

type Group = QueueItem["group"];

interface ScanStats {
  fetched: number;
  spam: number;
  failed: number;
  sensitive: number;
  sensitiveByKind: Record<string, number | undefined>;
}
type TabId = "all" | Group;

const GROUP_LABEL: Record<Group, string> = { work: "Work", school: "School", personal: "Personal", transactions: "Transactions", skipped: "Sensitive (not read)" };
const GROUP_STYLE: Record<Group, string> = {
  skipped: "bg-rose-500/20 text-rose-300",
  work: "bg-sky-500/20 text-sky-300",
  school: "bg-violet-500/20 text-violet-300",
  personal: "bg-amber-500/20 text-amber-300",
  transactions: "bg-emerald-500/20 text-emerald-300",
};
const TABS: TabId[] = ["all", "work", "school", "personal", "transactions"];

type PlayStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export function Dashboard({ name, email, sessionExpired }: { name: string; email: string; sessionExpired: boolean }) {
  const [voice, setVoice] = useState<ActiveVoice>(DEFAULT_VOICE);
  const [expired, setExpired] = useState(sessionExpired);
  const [count, setCount] = useState(10);
  const [length, setLength] = useState<SummaryLength>("medium");
  // Default: read every summary back to back. Off: stop after each email and wait for Next.
  const [continuous, setContinuous] = useState(true);
  const voiceRef = useRef<ActiveVoice>(DEFAULT_VOICE);
  voiceRef.current = voice;
  const autoStarted = useRef(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [stats, setStats] = useState<ScanStats | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [tab, setTab] = useState<TabId>("all");
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<PlayStatus>("idle");
  const [playError, setPlayError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Audio already paid for, keyed by email, voice and exact text, so replays never call ElevenLabs again.
  const cache = useRef(new Map<string, string>());
  const playToken = useRef(0);

  useEffect(() => {
    const saved = storageGet<ActiveVoice | null>("via.voice", null);
    if (saved?.id) {
      // Browser storage only exists after hydration, so saved choices are applied here, once.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVoice(saved);
      voiceRef.current = saved;
    }
    setContinuous(storageGet<boolean>("via.continuous", true));
    const savedLength = storageGet<SummaryLength>("via.length", "medium");
    // Opened from the Gmail button: ?length=short|medium|long&autostart=1
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("length");
    const chosen: SummaryLength = fromUrl === "short" || fromUrl === "medium" || fromUrl === "long" ? fromUrl : savedLength;
    setLength(chosen);
    if (fromUrl) storageSet("via.length", chosen);
    if (params.get("autostart") === "1" && !autoStarted.current) {
      autoStarted.current = true;
      // Drop the params so a page refresh doesn't start another scan.
      window.history.replaceState(null, "", window.location.pathname);
      void scan(chosen);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    async (item: QueueItem, text: string) => {
      const token = ++playToken.current;
      const el = audioRef.current;
      if (!el) return;
      el.pause();
      setPlayError(null);
      const voiceId = voiceRef.current.id;
      if (!voiceId) {
        setStatus("error");
        setPlayError("Pick a voice in the Voice Box first.");
        return;
      }
      const key = audioKey(item.id, voiceId, text);
      let url = cache.current.get(key);
      if (!url) {
        setStatus("loading");
        try {
          const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voiceId }) });
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
    [onAuthError],
  );

  async function scan(lengthOverride?: SummaryLength) {
    const summaryLength = lengthOverride ?? length;
    setScanning(true);
    setScanError(null);
    setStats(null);
    setQueue([]);
    setTab("all");
    // New summaries replace the old text, so drop audio made for the previous scan.
    for (const url of cache.current.values()) URL.revokeObjectURL(url);
    cache.current.clear();
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
      const res = await fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, // Character voices also bring their way of speaking.
        body: JSON.stringify({
          count,
          length: summaryLength,
          persona: voiceRef.current.label === BUTLER_NAME ? "butler" : voiceRef.current.label === "The Angry Coach" ? "coach" : "standard",
        }),
      });
      if (!res.ok) {
        const { message, code } = await readError(res);
        onAuthError(code);
        setScanError(message);
        return;
      }
      const json = (await res.json()) as { queue: QueueItem[]; stats: ScanStats };
      setQueue(json.queue);
      setStats(json.stats);
      // The All tab is selected after a scan, so the first email's text comes from the full queue.
      if (json.queue[0]) void playItem(json.queue[0], composeSpoken(json.queue)[0]!);
    } catch {
      setScanError("Couldn't reach the server. Check your connection.");
    } finally {
      setScanning(false);
    }
  }

  // The player steps through the emails in the selected tab. The spoken words ("Starting with…",
  // "First,", "Finally,") are rebuilt for that exact list, so they always match the order heard.
  const list = useMemo(() => (tab === "all" ? queue : queue.filter((q) => q.group === tab)), [queue, tab]);
  const spoken = useMemo(() => composeSpoken(list), [list]);
  const current = list[index];
  const currentText = spoken[index] ?? "";
  const atEnd = index >= list.length - 1;

  function changeTab(t: TabId) {
    if (t === tab) return;
    playToken.current++;
    audioRef.current?.pause();
    setTab(t);
    setIndex(0);
    setStatus("idle");
    setPlayError(null);
  }

  function next() {
    if (atEnd) return;
    const i = index + 1;
    setIndex(i);
    void playItem(list[i]!, spoken[i]!);
  }

  /** "Read all at once": when one summary finishes, start the next (audio is still made one email at a time). */
  function onEnded() {
    setStatus("ended");
    if (continuous && !atEnd) next();
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
    const cached = cache.current.get(audioKey(current.id, voice.id, currentText));
    if (el && cached && el.src === cached) {
      el.currentTime = 0;
      void el.play();
    } else {
      void playItem(current, currentText);
    }
  }

  function pauseResume() {
    const el = audioRef.current;
    if (!el) return;
    if (status === "playing") el.pause();
    else if (status === "paused") void el.play();
  }

  const btn = "inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-2.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Voice Inbox Assistant</h1>
          <p className="text-sm text-slate-400 [overflow-wrap:anywhere]">
            {name ? `${name} · ` : ""}
            {email}
          </p>
        </div>
        <form action={signOutAction}>
          <button className="min-h-11 rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800">Sign out</button>
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
            <select className="ml-2 min-h-11 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2" value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={scanning}>
              {[5, 10, 15, 20, 25, 30].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <div className="text-sm font-semibold">
            Summary length
            <div className="ml-2 inline-flex rounded-lg border border-slate-600 p-0.5" role="group" aria-label="Summary length">
              {(["short", "medium", "long"] as SummaryLength[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={length === l}
                  disabled={scanning}
                  onClick={() => {
                    setLength(l);
                    storageSet("via.length", l);
                  }}
                  className={`min-h-10 rounded-md px-3 py-1.5 capitalize ${length === l ? "bg-indigo-500 text-white" : "text-slate-300 hover:bg-slate-800"}`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              className="h-5 w-5 accent-indigo-500"
              checked={continuous}
              onChange={(e) => {
                setContinuous(e.target.checked);
                storageSet("via.continuous", e.target.checked);
              }}
            />
            Read all at once <span className="font-normal text-slate-400">(off: one email at a time)</span>
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
            Checked {stats.fetched} emails · {queue.filter((q) => q.group !== "skipped").length} to hear · {stats.spam} spam skipped
            {stats.failed ? ` · ${stats.failed} couldn't be summarized` : ""}
            {stats.sensitive > 0 && (
              <span className="ml-1 font-semibold text-rose-300">
                · 🔒 {stats.sensitive} sensitive {stats.sensitive === 1 ? "email" : "emails"} not opened (
                {Object.entries(stats.sensitiveByKind)
                  .filter(([, n]) => n)
                  .map(([k, n]) => `${n} ${k}`)
                  .join(", ")}
                )
              </span>
            )}
          </p>
        )}
      </section>

      {stats && queue.length === 0 && <p className="rounded-xl bg-slate-800 px-4 py-3">Nothing to hear: every email was spam or couldn&apos;t be summarized.</p>}

      {queue.length > 0 && (
        <nav className="flex flex-wrap gap-2" role="tablist" aria-label="Email categories">
          {TABS.map((t) => {
            const n = t === "all" ? queue.length : queue.filter((q) => q.group === t).length;
            return (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => changeTab(t)}
                className={`min-h-11 rounded-full px-4 py-2 text-sm font-semibold ${tab === t ? "bg-indigo-500 text-white" : "border border-slate-600 text-slate-200 hover:bg-slate-800"}`}
              >
                {t === "all" ? "All" : GROUP_LABEL[t]} <span className="opacity-70">({n})</span>
              </button>
            );
          })}
        </nav>
      )}

      {queue.length > 0 && list.length === 0 && <p className="rounded-xl bg-slate-800 px-4 py-3">No {GROUP_LABEL[tab as Group]} emails in this scan.</p>}

      {current && (
        <section className="rounded-2xl border border-indigo-400/40 bg-slate-900 p-6 shadow-xl" aria-labelledby="player-h" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="player-h" className="text-lg font-bold">
              {tab === "all" ? "Email" : `${GROUP_LABEL[tab]} email`} {index + 1} of {list.length}
            </h2>
            <span className={`rounded-full px-3 py-1 text-sm font-semibold ${GROUP_STYLE[current.group]}`}>{GROUP_LABEL[current.group]}</span>
          </div>
          <div className="mt-3 text-sm text-slate-400">
            {/* Wrapped, not cut off, so the full sender and subject are readable on a phone. */}
            <div className="[overflow-wrap:anywhere]" title={current.from}>
              From: {current.from}
            </div>
            <div className="[overflow-wrap:anywhere]" title={current.subject}>
              Subject: {current.subject}
            </div>
          </div>
          <p className="mt-4 whitespace-pre-line text-lg leading-relaxed [overflow-wrap:anywhere]">{currentText}</p>
          <p className="mt-2 text-xs text-slate-500 [overflow-wrap:anywhere]">
            AI-generated summary read by an AI voice (<span title={voice.label || undefined}>{voice.label || "no voice picked"}</span>).
          </p>

          <div className="mt-5 text-sm text-slate-300" role="status">
            {status === "loading" && "Generating audio…"}
            {status === "playing" && "Playing"}
            {status === "paused" && "Paused"}
            {status === "ended" &&
              (atEnd ? "Finished. That was your last email." : continuous ? "Moving to the next email…" : "Finished. Click Next Email when you're ready.")}
            {status === "idle" && "Not played yet. Click Listen to hear it."}
            {status === "error" && <span className="text-red-300">{playError}</span>}
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            {status === "idle" || status === "error" ? (
              <button className={`${btn} bg-indigo-500 text-white hover:bg-indigo-400`} onClick={() => void playItem(current, currentText)}>
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
        onEnded={onEnded}
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
