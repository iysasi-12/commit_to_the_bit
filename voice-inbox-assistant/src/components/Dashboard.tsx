"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reconnectGoogle, signOutAction } from "@/app/actions";
import { SetupWizard, type SetupChoice } from "@/components/SetupWizard";
import { BUTLER_NAME, VoiceBox } from "@/components/VoiceBox";
import { afterEnded, parseMode, parsePause, PAUSE_LABEL, PAUSE_LEVELS, PAUSE_MS, type PauseLevel, type ReadingMode } from "@/lib/playback";
import type { SummaryLength } from "@/lib/system-prompt";
import { parseWindow, TIME_WINDOWS, windowLabel, type TimeWindow } from "@/lib/time-window";
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
  /** The time window used (8, 16 or 48 hours), or null for "newest emails, any time". */
  hours: TimeWindow | null;
  spam: number;
  failed: number;
  aiError?: string | null;
  sensitive: number;
  sensitiveByKind: Record<string, number | undefined>;
}
type TabId = "all" | Group;
type Handled = { kind: "trashed" } | { kind: "moved"; label: string };
interface GmailLabel {
  id: string;
  name: string;
}

const GROUP_LABEL: Record<Group, string> = {
  work: "Work",
  school: "School",
  personal: "Personal",
  transactions: "Transactions",
  spam: "Possible spam",
  skipped: "Sensitive (not read)",
};
const GROUP_STYLE: Record<Group, string> = {
  skipped: "bg-rose-500/20 text-rose-300",
  spam: "bg-orange-500/20 text-orange-300",
  work: "bg-sky-500/20 text-sky-300",
  school: "bg-violet-500/20 text-violet-300",
  personal: "bg-amber-500/20 text-amber-300",
  transactions: "bg-emerald-500/20 text-emerald-300",
};
const TABS: TabId[] = ["all", "work", "school", "personal", "transactions", "spam"];
/** "Up to" choices. With a time window this is a cap (and protects the Gemini quota). */
const COUNTS = [5, 10, 15, 20, 25, 30, 40, 50];
/** A scan can be resumed (e.g. after leaving Gmail) for this long. Cleared on sign-out. */
const RESUME_MS = 3 * 60 * 60 * 1000;
/** Words in a Gmail label name that make it a good destination for each section. */
const LABEL_HINTS: Partial<Record<Group, RegExp>> = {
  work: /work|job|office|project|team/i,
  school: /school|class|course|uni|college|homework/i,
  personal: /personal|friend|family|social/i,
  transactions: /receipt|order|purchase|shop|bill|financ|transaction|payment/i,
  spam: /spam|junk|suspicious/i,
};

type PlayStatus = "idle" | "loading" | "playing" | "paused" | "between" | "ended" | "error";

interface SavedSession {
  queue: QueueItem[];
  stats: ScanStats | null;
  index: number;
  tab: TabId;
  handled: Record<string, Handled>;
  savedAt: number;
}

export function Dashboard({ name, email, sessionExpired, canModify }: { name: string; email: string; sessionExpired: boolean; canModify: boolean }) {
  const [voice, setVoice] = useState<ActiveVoice>(DEFAULT_VOICE);
  const [expired, setExpired] = useState(sessionExpired);
  const [count, setCount] = useState(10);
  // null = the newest emails, any time; otherwise only emails from the last 8, 16 or 48 hours.
  const [hours, setHours] = useState<TimeWindow | null>(null);
  const [length, setLength] = useState<SummaryLength>("medium");
  const [mode, setMode] = useState<ReadingMode>("all");
  const [pause, setPause] = useState<PauseLevel>("medium");
  const voiceRef = useRef<ActiveVoice>(DEFAULT_VOICE);
  voiceRef.current = voice;
  const autoStarted = useRef(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [stats, setStats] = useState<ScanStats | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [tab, setTab] = useState<TabId>("all");
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<PlayStatus>("idle");
  const statusRef = useRef<PlayStatus>("idle");
  statusRef.current = status;
  const [playError, setPlayError] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const [handled, setHandled] = useState<Record<string, Handled>>({});
  const [actionBusy, setActionBusy] = useState<"trash" | "move" | null>(null);
  const [actionError, setActionError] = useState<{ message: string; needsPermission: boolean } | null>(null);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [labels, setLabels] = useState<GmailLabel[] | null>(null);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Audio already paid for, keyed by email, voice and exact text, so replays never call ElevenLabs again.
  const cache = useRef(new Map<string, string>());
  // Audio being made right now (also used to prepare the next email while this one plays).
  const inflight = useRef(new Map<string, Promise<string>>());
  // Every start, stop, skip or navigation bumps this, so stale requests and timers do nothing.
  const playToken = useRef(0);
  // The one pending "go to the next email after the pause" timer.
  const advanceTimer = useRef<number | null>(null);
  const sessionKey = `via.session:${email.toLowerCase()}`;

  const clearAdvance = useCallback(() => {
    if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    advanceTimer.current = null;
  }, []);

  useEffect(() => {
    const saved = storageGet<ActiveVoice | null>("via.voice", null);
    if (saved?.id) {
      // Browser storage only exists after hydration, so saved choices are applied here, once.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVoice(saved);
      voiceRef.current = saved;
    }
    setMode(parseMode(storageGet<unknown>("via.mode", null), storageGet<unknown>("via.continuous", true)));
    const savedCount = storageGet<number>("via.count", 10);
    if (COUNTS.includes(savedCount)) setCount(savedCount);
    const savedLength = storageGet<SummaryLength>("via.length", "medium");
    const params = new URLSearchParams(window.location.search);
    // The extension passes its saved pause level (the extension and the app share one setting).
    const chosenPause = params.has("pause") ? parsePause(params.get("pause")) : parsePause(storageGet<unknown>("via.pause", null));
    setPause(chosenPause);
    if (params.has("pause")) storageSet("via.pause", chosenPause);
    // Older Gmail button: ?length=short|medium|long&autostart=1 (and optionally &hours=8|16|48)
    const fromUrl = params.get("length");
    const chosen: SummaryLength = fromUrl === "short" || fromUrl === "medium" || fromUrl === "long" ? fromUrl : savedLength;
    setLength(chosen);
    if (fromUrl) storageSet("via.length", chosen);
    const chosenHours = params.has("hours") ? parseWindow(params.get("hours")) : parseWindow(storageGet<number | null>("via.hours", null));
    setHours(chosenHours);
    if (params.has("hours")) storageSet("via.hours", chosenHours);

    // Pick up where you left off (e.g. after leaving Gmail and coming back).
    const session = storageGet<SavedSession | null>(sessionKey, null);
    if (session && Date.now() - session.savedAt < RESUME_MS && session.queue?.length) {
      setQueue(session.queue);
      setStats(session.stats);
      setTab(session.tab ?? "all");
      setIndex(Math.min(session.index ?? 0, session.queue.length - 1));
      setHandled(session.handled ?? {});
      setStatus("idle");
      setResumed(true);
    }

    const autostart = params.get("autostart") === "1" && !autoStarted.current;
    if (params.get("setup") === "1") setWizardOpen(true);
    if ([...params.keys()].length) window.history.replaceState(null, "", window.location.pathname);
    if (autostart) {
      autoStarted.current = true;
      void scan({ length: chosen, hours: chosenHours, count: COUNTS.includes(savedCount) ? savedCount : 10 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the queue so it can be resumed; nothing here leaves this browser.
  useEffect(() => {
    if (!queue.length) return;
    storageSet(sessionKey, { queue, stats, index, tab, handled, savedAt: Date.now() } satisfies SavedSession);
  }, [queue, stats, index, tab, handled, sessionKey]);

  // Leaving (another tab, or the side panel closing): pause, and cancel any pending advance.
  useEffect(() => {
    const audio = audioRef.current;
    const onHide = (e: Event) => {
      if (e.type !== "pagehide" && document.visibilityState !== "hidden") return;
      clearAdvance();
      playToken.current++;
      if (audio && !audio.paused) audio.pause();
      if (statusRef.current === "between" || statusRef.current === "loading") setStatus("ended");
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
      clearAdvance();
      audio?.pause();
    };
  }, [clearAdvance]);

  // Messages from the extension panel: a new pause level from the Options page, or "you left
  // this Gmail tab" (pause and cancel any pending advance; the queue stays for later).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (window.parent === window || e.source !== window.parent) return;
      const data = e.data as { type?: unknown; pause?: unknown } | null;
      if (data?.type === "via-pause-playback") {
        clearAdvance();
        playToken.current++;
        const audio = audioRef.current;
        if (audio && !audio.paused) audio.pause();
        if (statusRef.current === "between" || statusRef.current === "loading") setStatus("ended");
        return;
      }
      if (data?.type !== "via-settings") return;
      const p = parsePause(data.pause);
      setPause(p);
      storageSet("via.pause", p);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [clearAdvance]);

  const selectVoice = useCallback((v: ActiveVoice) => {
    setVoice(v);
    voiceRef.current = v;
    storageSet("via.voice", v);
  }, []);

  const onAuthError = useCallback((code: string) => {
    if (code === "SESSION_EXPIRED" || code === "NOT_SIGNED_IN") setExpired(true);
  }, []);

  function changeMode(m: ReadingMode) {
    setMode(m);
    storageSet("via.mode", m);
    // Switching to One at a time must never let a pending auto-advance through.
    if (m === "one") {
      clearAdvance();
      if (status === "between") setStatus("ended");
    }
  }

  function changePause(p: PauseLevel) {
    setPause(p);
    storageSet("via.pause", p);
    if (window.parent !== window) window.parent.postMessage({ type: "via-pause-changed", pause: p }, "*");
  }

  /** Audio for one email: from the cache, an in-flight request, or a new request. */
  const ensureAudio = useCallback(
    (item: QueueItem, text: string, voiceId: string): Promise<string> => {
      const key = audioKey(item.id, voiceId, text);
      const cached = cache.current.get(key);
      if (cached) return Promise.resolve(cached);
      const pending = inflight.current.get(key);
      if (pending) return pending;
      const request = (async () => {
        const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voiceId }) });
        if (!res.ok) {
          const { message, code } = await readError(res);
          onAuthError(code);
          throw new Error(message);
        }
        const url = URL.createObjectURL(await res.blob());
        cache.current.set(key, url);
        return url;
      })().finally(() => inflight.current.delete(key));
      inflight.current.set(key, request);
      return request;
    },
    [onAuthError],
  );

  /** Fetches (or reuses) audio for one email and plays it. */
  const playItem = useCallback(
    async (item: QueueItem, text: string) => {
      clearAdvance();
      const token = ++playToken.current;
      const el = audioRef.current;
      if (!el) return;
      el.pause();
      setPlayError(null);
      setActionError(null);
      const voiceId = voiceRef.current.id;
      if (!voiceId) {
        setStatus("error");
        setPlayError("Pick a voice in the Voice Box first.");
        return;
      }
      if (!cache.current.has(audioKey(item.id, voiceId, text))) setStatus("loading");
      let url: string;
      try {
        url = await ensureAudio(item, text, voiceId);
      } catch (err) {
        if (token === playToken.current) {
          setStatus("error");
          setPlayError(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Couldn't reach the server for audio. Check your connection.");
        }
        return;
      }
      if (token !== playToken.current) return; // something else started or stopped meanwhile
      // Already loaded during the pause (see onEnded)? Then don't reload it: start right away.
      if (el.src !== url) el.src = url;
      el.currentTime = 0;
      try {
        await el.play();
      } catch {
        // Browsers can block audio that starts without a click; the Play button covers it.
        if (token === playToken.current) setStatus("paused");
      }
    },
    [clearAdvance, ensureAudio],
  );

  async function scan(over: { length?: SummaryLength; hours?: TimeWindow | null; count?: number } = {}) {
    const summaryLength = over.length ?? length;
    const window_ = over.hours !== undefined ? over.hours : hours;
    const max = over.count ?? count;
    clearAdvance();
    playToken.current++;
    setScanning(true);
    setScanError(null);
    setStats(null);
    setQueue([]);
    setTab("all");
    setHandled({});
    setResumed(false);
    setLabelsOpen(false);
    setActionError(null);
    try {
      window.localStorage.removeItem(sessionKey);
    } catch {}
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
      const res = await fetch("/api/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count: max,
          hours: window_,
          length: summaryLength,
          // Character voices also bring their way of speaking.
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
      // The All tab is selected after a scan; it never reads possible spam.
      const all = json.queue.filter((q) => q.group !== "spam");
      if (all[0]) void playItem(all[0], composeSpoken(all)[0]!);
    } catch {
      setScanError("Couldn't reach the server. Check your connection.");
    } finally {
      setScanning(false);
    }
  }

  function startFromWizard(choice: SetupChoice) {
    changeMode(choice.mode);
    setLength(choice.length);
    storageSet("via.length", choice.length);
    selectVoice(choice.voice);
    setWizardOpen(false);
    void scan({ length: choice.length });
  }

  // The player steps through the emails in the selected tab. The spoken words ("Starting with…",
  // "First,", "Finally,") are rebuilt for that exact list, so they always match the order heard.
  const list = useMemo(() => (tab === "all" ? queue.filter((q) => q.group !== "spam") : queue.filter((q) => q.group === tab)), [queue, tab]);
  const spoken = useMemo(() => composeSpoken(list), [list]);
  const current = list[index];
  const currentText = spoken[index] ?? "";
  const atEnd = index >= list.length - 1;
  const currentHandled = current ? handled[current.id] : undefined;
  const actionable = Boolean(current && current.group !== "skipped" && !currentHandled);

  // All at once: while one email plays, prepare the next one's audio so the only gap is the pause.
  useEffect(() => {
    if (mode !== "all" || status !== "playing") return;
    const nextItem = list[index + 1];
    const voiceId = voiceRef.current.id;
    if (nextItem && voiceId) void ensureAudio(nextItem, spoken[index + 1]!, voiceId).catch(() => {});
  }, [mode, status, index, list, spoken, ensureAudio]);

  function goTo(i: number, play: boolean) {
    clearAdvance();
    setLabelsOpen(false);
    setActionError(null);
    setIndex(i);
    if (play && list[i]) {
      void playItem(list[i]!, spoken[i]!);
    } else {
      playToken.current++;
      audioRef.current?.pause();
      setStatus("idle");
      setPlayError(null);
    }
  }

  function changeTab(t: TabId) {
    if (t === tab) return;
    clearAdvance();
    playToken.current++;
    audioRef.current?.pause();
    setTab(t);
    setIndex(0);
    setStatus("idle");
    setPlayError(null);
    setLabelsOpen(false);
  }

  /** Next: leave this email exactly as it is and play the next one. */
  function next() {
    if (atEnd) return;
    goTo(index + 1, true);
  }

  function onEnded() {
    const decision = afterEnded(mode, atEnd, pause);
    if (decision.kind !== "advance") {
      setStatus("ended");
      return;
    }
    setStatus("between");
    const token = playToken.current;
    const target = index + 1;
    // Load the next email's (already prepared) audio during the pause, so the silence is the
    // chosen pause and not pause + loading.
    const nextItem = list[target];
    const nextUrl = nextItem ? cache.current.get(audioKey(nextItem.id, voiceRef.current.id, spoken[target]!)) : undefined;
    const el = audioRef.current;
    if (el && nextUrl) {
      el.src = nextUrl;
      el.load();
    }
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = null;
      if (token !== playToken.current) return; // paused, skipped, stopped or navigated meanwhile
      goTo(target, true);
    }, decision.delayMs);
  }

  function skip() {
    if (atEnd) return;
    goTo(index + 1, false);
  }

  function replay() {
    if (!current) return;
    clearAdvance();
    const el = audioRef.current;
    const cached = cache.current.get(audioKey(current.id, voice.id, currentText));
    if (el && cached && el.src === cached) {
      playToken.current++;
      el.currentTime = 0;
      void el.play();
    } else {
      void playItem(current, currentText);
    }
  }

  function pauseResume() {
    const el = audioRef.current;
    if (!el) return;
    if (status === "between") {
      // Stop before the next email; Next continues.
      clearAdvance();
      playToken.current++;
      setStatus("ended");
    } else if (status === "playing") el.pause();
    else if (status === "paused") void el.play();
  }

  async function act(kind: "trash" | "move", label?: GmailLabel) {
    if (!current || !actionable) return;
    const item = current;
    clearAdvance();
    playToken.current++;
    audioRef.current?.pause();
    setActionBusy(kind);
    setActionError(null);
    try {
      const res = await fetch(`/api/emails/${encodeURIComponent(item.id)}/${kind === "trash" ? "trash" : "move"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: kind === "move" ? JSON.stringify({ labelId: label!.id }) : "{}",
      });
      if (!res.ok) {
        const { message, code } = await readError(res);
        onAuthError(code);
        setActionError({ message, needsPermission: code === "GMAIL_NEEDS_PERMISSION" });
        setStatus("ended");
        return;
      }
      setHandled((h) => ({ ...h, [item.id]: kind === "trash" ? { kind: "trashed" } : { kind: "moved", label: label!.name } }));
      setLabelsOpen(false);
      // The person decided; move on (the last email simply stays shown as done).
      if (!atEnd) goTo(index + 1, true);
      else setStatus("ended");
    } catch {
      setActionError({ message: "Couldn't reach the server. Check your connection.", needsPermission: false });
    } finally {
      setActionBusy(null);
    }
  }

  async function openReorganize() {
    if (!actionable) return;
    clearAdvance();
    if (status === "between") setStatus("ended");
    setLabelsOpen(true);
    if (labels) return;
    setLabelsError(null);
    try {
      const res = await fetch("/api/labels");
      if (!res.ok) {
        const { message, code } = await readError(res);
        onAuthError(code);
        setLabelsError(message);
        return;
      }
      setLabels(((await res.json()) as { labels: GmailLabel[] }).labels);
    } catch {
      setLabelsError("Couldn't load your Gmail labels. Check your connection.");
    }
  }

  const sortedLabels = useMemo(() => {
    if (!labels || !current) return [];
    const hint = LABEL_HINTS[current.group];
    return [...labels].sort((a, b) => Number(Boolean(hint?.test(b.name))) - Number(Boolean(hint?.test(a.name))));
  }, [labels, current]);

  function clearSavedOnSignOut() {
    try {
      window.localStorage.removeItem(sessionKey);
    } catch {}
  }

  const btn = "inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-2.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40";
  const seg = (on: boolean) => `min-h-10 rounded-md px-3 py-1.5 ${on ? "bg-indigo-500 text-white" : "text-slate-300 hover:bg-slate-800"}`;
  const visibleTabs = TABS.filter((t) => t !== "spam" || queue.some((q) => q.group === "spam"));

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Voice Inbox Assistant</h1>
          <p className="text-sm text-slate-400 [overflow-wrap:anywhere]">
            {name ? `${name} · ` : ""}
            {email}
          </p>
        </div>
        <form action={signOutAction} onSubmit={clearSavedOnSignOut}>
          <button className="min-h-11 rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800">Sign out</button>
        </form>
      </header>

      {expired && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/50 bg-amber-500/15 px-4 py-3" role="alert">
          <span className="text-amber-200">Your Google session expired or access was removed (Google limits apps in Testing mode to 7 days).</span>
          <form action={reconnectGoogle}>
            <button className="min-h-11 rounded-lg bg-amber-400 px-4 py-2 font-semibold text-slate-900 hover:bg-amber-300">Session Expired — Sign Out &amp; Reconnect Google</button>
          </form>
        </div>
      )}

      {wizardOpen && (
        <SetupWizard initial={{ mode, length, voice }} onStart={startFromWizard} onCancel={() => setWizardOpen(false)} />
      )}

      <VoiceBox active={voice} onSelect={selectVoice} onAuthError={onAuthError} />

      <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-5" aria-labelledby="scan-h">
        <h2 id="scan-h" className="text-lg font-bold">
          Settings &amp; scan
        </h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-sm font-semibold">
            From
            <select
              className="ml-2 min-h-11 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2"
              value={hours ?? ""}
              onChange={(e) => {
                const h = parseWindow(e.target.value);
                setHours(h);
                storageSet("via.hours", h);
              }}
              disabled={scanning}
            >
              <option value="">Newest emails</option>
              {TIME_WINDOWS.map((h) => (
                <option key={h} value={h}>
                  Last {h} hours
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-semibold">
            Up to
            <select
              className="mx-2 min-h-11 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2"
              value={count}
              onChange={(e) => {
                setCount(Number(e.target.value));
                storageSet("via.count", Number(e.target.value));
              }}
              disabled={scanning}
            >
              {COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            emails
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
                  className={`${seg(length === l)} capitalize`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="text-sm font-semibold">
            Reading
            <div className="ml-2 inline-flex rounded-lg border border-slate-600 p-0.5" role="group" aria-label="Reading">
              {(
                [
                  ["all", "All at once"],
                  ["one", "One at a time"],
                ] as Array<[ReadingMode, string]>
              ).map(([m, label]) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => changeMode(m)} className={seg(mode === m)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="text-sm font-semibold">
            <span id="pause-label">Pause between emails</span>
            <div className="ml-2 inline-flex rounded-lg border border-slate-600 p-0.5" role="group" aria-labelledby="pause-label">
              {PAUSE_LEVELS.map((p) => (
                <button key={p} type="button" aria-pressed={pause === p} onClick={() => changePause(p)} className={seg(pause === p)} title={`${PAUSE_MS[p] / 1000} seconds of silence`}>
                  {PAUSE_LABEL[p]} <span className="font-normal opacity-80">({PAUSE_MS[p] / 1000} s)</span>
                </button>
              ))}
            </div>
            {mode === "one" && <span className="ml-2 font-normal text-slate-400">(One at a time always waits for you)</span>}
          </div>
          <button className={`${btn} bg-indigo-500 text-white hover:bg-indigo-400`} onClick={() => void scan()} disabled={scanning || expired}>
            {scanning ? "Reading and summarizing…" : "Scan & Summarize Inbox"}
          </button>
          <button className={`${btn} border border-slate-600 hover:bg-slate-800`} onClick={() => setWizardOpen(true)} disabled={scanning || expired}>
            Guided setup…
          </button>
        </div>
        {scanError && (
          <p className="mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300" role="alert">
            {scanError}
          </p>
        )}
        {stats?.aiError && (
          <p className="mt-3 rounded-lg bg-amber-500/15 px-3 py-2 text-sm text-amber-200" role="alert">
            {stats.aiError} The emails are still listed below.
          </p>
        )}
        {stats && (
          <p className="mt-3 text-sm text-slate-400">
            Checked {stats.fetched} {stats.fetched === 1 ? "email" : "emails"}
            {stats.hours ? ` from the last ${stats.hours} hours` : ""} · {queue.filter((q) => q.group !== "skipped" && q.group !== "spam").length} to hear
            {stats.spam ? ` · ${stats.spam} possible spam set aside (not moved or deleted)` : ""}
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

      {resumed && (
        <p className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-800 px-4 py-3" role="status">
          <span>Picked up where you left off. Press Listen to continue.</span>
          <button className={`${btn} border border-slate-600 hover:bg-slate-700`} onClick={() => void scan()} disabled={scanning || expired}>
            Start over
          </button>
        </p>
      )}

      {stats && queue.length === 0 && (
        <p className="rounded-xl bg-slate-800 px-4 py-3">{stats.fetched === 0 ? `No emails in ${windowLabel(stats.hours)}.` : "Nothing to hear in this scan."}</p>
      )}

      {queue.length > 0 && (
        <nav className="flex flex-wrap gap-2" role="tablist" aria-label="Email categories">
          {visibleTabs.map((t) => {
            const n = t === "all" ? queue.filter((q) => q.group !== "spam").length : queue.filter((q) => q.group === t).length;
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
        <section className="rounded-2xl border border-indigo-400/40 bg-slate-900 p-5 shadow-xl sm:p-6" aria-labelledby="player-h" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="player-h" className="text-lg font-bold">
              {tab === "all" ? "Email" : `${GROUP_LABEL[tab]} email`} {index + 1} of {list.length}
            </h2>
            <div className="flex flex-wrap gap-2">
              {current.note === "unsummarized" && <span className="rounded-full bg-slate-700 px-3 py-1 text-sm font-semibold text-slate-200">Couldn&apos;t summarize</span>}
              {currentHandled && (
                <span className="rounded-full bg-slate-700 px-3 py-1 text-sm font-semibold text-slate-100">
                  {currentHandled.kind === "trashed" ? "Moved to Trash" : `Moved to ${currentHandled.label}`}
                </span>
              )}
              <span className={`rounded-full px-3 py-1 text-sm font-semibold ${GROUP_STYLE[current.group]}`}>{GROUP_LABEL[current.group]}</span>
            </div>
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
          {current.reasons?.length ? (
            <p className="mt-2 text-sm text-orange-300">Set aside because: {current.reasons.join("; ")}. It wasn&apos;t moved or deleted in Gmail.</p>
          ) : null}
          <p className="mt-2 text-xs text-slate-500 [overflow-wrap:anywhere]">
            AI-generated summary read by an AI voice (<span title={voice.label || undefined}>{voice.label || "no voice picked"}</span>).
          </p>

          <div className="mt-5 text-sm text-slate-300" role="status">
            {status === "loading" && "Getting the audio ready…"}
            {status === "playing" && "Playing"}
            {status === "paused" && "Paused"}
            {status === "between" && `Next email in ${PAUSE_MS[pause] / 1000} s…`}
            {status === "ended" &&
              (mode === "one"
                ? atEnd
                  ? "Done. Delete it, reorganize it, or you're finished."
                  : "Done. Delete, Next, or Reorganize? I'll wait."
                : atEnd
                  ? "Finished. That was your last email."
                  : "Stopped. Click Next when you're ready.")}
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
                {status === "playing" ? "Pause" : status === "between" ? "Stop here" : "Resume"}
              </button>
            )}
            <button className={`${btn} bg-slate-700 hover:bg-slate-600`} onClick={replay} disabled={status === "loading"}>
              Replay
            </button>
            {mode === "all" && (
              <button className={`${btn} bg-slate-700 hover:bg-slate-600`} onClick={skip} disabled={atEnd}>
                Skip
              </button>
            )}
          </div>

          {current.group !== "skipped" && (
            <div className="mt-3 flex flex-wrap gap-3" role="group" aria-label="What to do with this email">
              <button className={`${btn} bg-rose-600 text-white hover:bg-rose-500`} onClick={() => void act("trash")} disabled={!actionable || !canModify || actionBusy !== null}>
                {actionBusy === "trash" ? "Moving to Trash…" : "🗑 Delete"}
              </button>
              <button className={`${btn} bg-indigo-500 text-white hover:bg-indigo-400`} onClick={next} disabled={atEnd || status === "loading" || actionBusy !== null}>
                Next →
              </button>
              <button className={`${btn} border border-slate-500 hover:bg-slate-800`} onClick={() => void openReorganize()} disabled={!actionable || !canModify || actionBusy !== null} aria-expanded={labelsOpen}>
                📁 Reorganize…
              </button>
            </div>
          )}

          {!canModify && current.group !== "skipped" && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-300">
              <span>Delete and Reorganize need permission to manage your Gmail. Next always works.</span>
              <form action={reconnectGoogle}>
                <button className="min-h-11 rounded-lg border border-slate-500 px-3 py-2 font-semibold hover:bg-slate-700">Sign in again to allow</button>
              </form>
            </div>
          )}

          {actionError && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300" role="alert">
              <span>{actionError.message}</span>
              {actionError.needsPermission && (
                <form action={reconnectGoogle}>
                  <button className="min-h-11 rounded-lg bg-amber-400 px-3 py-2 font-semibold text-slate-900 hover:bg-amber-300">Sign in again to allow</button>
                </form>
              )}
            </div>
          )}

          {labelsOpen && (
            <div className="mt-4 rounded-xl border border-slate-600 p-4" role="dialog" aria-label="Choose where to move this email">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-bold">Move to which label?</h3>
                <button className={`${btn} border border-slate-600 text-sm hover:bg-slate-800`} onClick={() => setLabelsOpen(false)}>
                  Cancel
                </button>
              </div>
              <p className="mt-1 text-sm text-slate-400">It gets that label and leaves the Inbox. Its other labels stay.</p>
              {!labels && !labelsError && <p className="mt-3 text-slate-400">Loading your labels…</p>}
              {labelsError && (
                <p className="mt-3 text-sm text-red-300" role="alert">
                  {labelsError}
                </p>
              )}
              {labels && labels.length === 0 && <p className="mt-3 text-slate-300">You don&apos;t have any Gmail labels yet. Create one in Gmail (for example &ldquo;Work&rdquo;), then try again.</p>}
              {labels && labels.length > 0 && (
                <ul className="mt-3 flex max-h-64 flex-wrap gap-2 overflow-y-auto">
                  {sortedLabels.map((l, i) => {
                    const suggested = i === 0 && Boolean(LABEL_HINTS[current.group]?.test(l.name));
                    return (
                      <li key={l.id}>
                        <button className={`${btn} flex-wrap gap-x-2 border text-sm ${suggested ? "border-indigo-400 bg-indigo-500/15" : "border-slate-600 hover:bg-slate-800"}`} onClick={() => void act("move", l)} disabled={actionBusy !== null} title={l.name}>
                          <span className="[overflow-wrap:anywhere]">{l.name}</span>
                          {suggested && <span className="whitespace-nowrap text-xs text-indigo-300">Suggested</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      <audio
        ref={audioRef}
        onPlay={() => setStatus("playing")}
        onPause={(e) => {
          if (!e.currentTarget.ended) setStatus((s) => (s === "loading" || s === "between" || s === "ended" ? s : "paused"));
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
