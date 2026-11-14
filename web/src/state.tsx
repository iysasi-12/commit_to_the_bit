import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api, errorMessage } from "./api.ts";
import type { AppConfigInfo, AudioInfo, CategoriesResponse, InboxResponse, Me, Summary } from "./types.ts";

// ---------------------------------------------------------------------------
// App data: config, the signed-in person, inbox and categories
// ---------------------------------------------------------------------------

interface AppData {
  config: AppConfigInfo;
  me: Me;
  setMe: (me: Me) => void;
  inbox: InboxResponse | null;
  inboxError: string | null;
  inboxLoading: boolean;
  loadInbox: (refresh?: boolean) => Promise<void>;
  sorting: boolean;
  sortError: string | null;
  sortInbox: (opts?: { silent?: boolean }) => Promise<void>;
  categories: CategoriesResponse | null;
  setCategories: (c: CategoriesResponse) => void;
  requestConsent: () => Promise<boolean>;
  consentOpen: boolean;
  resolveConsent: (accepted: boolean) => void;
  signOut: () => Promise<void>;
}

const AppCtx = createContext<AppData | null>(null);

export function useApp(): AppData {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}

export function AppProvider({ config, initialMe, children, onSignedOut }: { config: AppConfigInfo; initialMe: Me; children: ReactNode; onSignedOut: () => void }) {
  const [me, setMe] = useState<Me>(initialMe);
  const [inbox, setInbox] = useState<InboxResponse | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [sortError, setSortError] = useState<string | null>(null);
  const [categories, setCategoriesState] = useState<CategoriesResponse | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const consentResolvers = useRef<Array<(ok: boolean) => void>>([]);
  const meRef = useRef(me);
  meRef.current = me;

  const requestConsent = useCallback(() => {
    if (meRef.current.consent.accepted) return Promise.resolve(true);
    setConsentOpen(true);
    return new Promise<boolean>((resolve) => consentResolvers.current.push(resolve));
  }, []);

  const resolveConsent = useCallback((accepted: boolean) => {
    setConsentOpen(false);
    const pending = consentResolvers.current.splice(0);
    pending.forEach((r) => r(accepted));
  }, []);

  const sortInbox = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!meRef.current.consent.accepted) {
      if (opts.silent) return;
      const ok = await requestConsent();
      if (!ok) return;
    }
    setSorting(true);
    setSortError(null);
    try {
      const result = await api<InboxResponse & { assigned: number }>("/api/inbox/classify", { method: "POST" });
      setInbox({ messages: result.messages, unclassified: result.unclassified, categoriesVersion: result.categoriesVersion });
    } catch (err) {
      setSortError(errorMessage(err));
    } finally {
      setSorting(false);
    }
  }, [requestConsent]);

  const loadInbox = useCallback(async (refresh = false) => {
    setInboxLoading(true);
    setInboxError(null);
    try {
      const data = await api<InboxResponse>(`/api/inbox${refresh ? "?refresh=1" : ""}`);
      setInbox(data);
      if (data.unclassified > 0 && meRef.current.settings.autoSort && meRef.current.consent.accepted) {
        void sortInbox({ silent: true });
      }
    } catch (err) {
      setInboxError(errorMessage(err));
      if (err instanceof ApiError && err.code === "UNAUTHENTICATED") onSignedOut();
    } finally {
      setInboxLoading(false);
    }
  }, [sortInbox, onSignedOut]);

  const setCategories = useCallback((c: CategoriesResponse) => {
    setCategoriesState((prev) => {
      if (prev && prev.categoriesVersion !== c.categoriesVersion) {
        // Category changes reset the sort; reload so the list reflects it.
        setTimeout(() => void loadInbox(), 0);
      }
      return c;
    });
  }, [loadInbox]);

  useEffect(() => {
    void loadInbox();
    api<CategoriesResponse>("/api/categories").then(setCategoriesState, () => undefined);
  }, [loadInbox]);

  // Right after someone agrees to AI processing, sort what's already loaded.
  const unclassified = inbox?.unclassified ?? 0;
  useEffect(() => {
    if (me.consent.accepted && me.settings.autoSort && unclassified > 0 && !sorting) void sortInbox({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.consent.accepted]);

  const signOut = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      onSignedOut();
    }
  }, [onSignedOut]);

  const value = useMemo<AppData>(
    () => ({
      config,
      me,
      setMe,
      inbox,
      inboxError,
      inboxLoading,
      loadInbox,
      sorting,
      sortError,
      sortInbox,
      categories,
      setCategories,
      requestConsent,
      consentOpen,
      resolveConsent,
      signOut,
    }),
    [config, me, inbox, inboxError, inboxLoading, loadInbox, sorting, sortError, sortInbox, categories, setCategories, requestConsent, consentOpen, resolveConsent, signOut],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

// ---------------------------------------------------------------------------
// Player: summary -> speech -> playback, one at a time
// ---------------------------------------------------------------------------

export type PlayRequest =
  | { kind: "inbox"; label: string }
  | { kind: "category"; categoryId: string; label: string }
  | { kind: "message"; messageId: string; label: string };

export type PlayerStatus = "idle" | "summarizing" | "voicing" | "ready" | "playing" | "paused" | "ended" | "error";

export interface PlayerState {
  status: PlayerStatus;
  request: PlayRequest | null;
  summary: Summary | null;
  audio: AudioInfo | null;
  cached: { summary: boolean; audio: boolean };
  error: string | null;
  retryable: boolean;
  currentTime: number;
  duration: number;
}

interface PlayerApi {
  state: PlayerState;
  play: (req: PlayRequest) => Promise<void>;
  toggle: () => void;
  replay: () => void;
  seek: (t: number) => void;
  close: () => void;
  retry: () => void;
}

const PlayerCtx = createContext<PlayerApi | null>(null);

export function usePlayer(): PlayerApi {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer outside provider");
  return ctx;
}

const IDLE: PlayerState = {
  status: "idle",
  request: null,
  summary: null,
  audio: null,
  cached: { summary: false, audio: false },
  error: null,
  retryable: false,
  currentTime: 0,
  duration: 0,
};

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { me, requestConsent } = useApp();
  const [state, setState] = useState<PlayerState>(IDLE);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const run = useRef(0);
  const meRef = useRef(me);
  meRef.current = me;

  const patch = useCallback((p: Partial<PlayerState>) => setState((s) => ({ ...s, ...p })), []);

  const play = useCallback(
    async (req: PlayRequest) => {
      const id = ++run.current;
      const el = audioRef.current;
      if (el) {
        el.pause();
        el.removeAttribute("src");
      }
      setState({ ...IDLE, status: "summarizing", request: req });
      const body =
        req.kind === "message" ? { scope: "one", messageId: req.messageId } : req.kind === "category" ? { scope: "many", categoryId: req.categoryId } : { scope: "many" };
      let summary: Summary | null = null;
      try {
        const s = await api<{ summary: Summary; cached: boolean }>("/api/summaries", { method: "POST", body });
        if (id !== run.current) return;
        summary = s.summary;
        setState((st) => ({ ...st, status: "voicing", summary: s.summary, cached: { summary: s.cached, audio: false } }));
        const a = await api<{ audio: AudioInfo; cached: boolean }>(`/api/summaries/${s.summary.id}/audio`, { method: "POST" });
        if (id !== run.current || !audioRef.current) return;
        const audioEl = audioRef.current;
        audioEl.src = a.audio.url;
        audioEl.load();
        setState((st) => ({ ...st, status: "ready", audio: a.audio, cached: { summary: st.cached.summary, audio: a.cached } }));
        if ("mediaSession" in navigator && typeof MediaMetadata !== "undefined") {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: s.summary.title,
            artist: `Inbox Voice · AI voice${a.audio.voiceName ? ` (${a.audio.voiceName})` : ""}`,
            album: "AI-generated email summary",
          });
        }
        if (meRef.current.settings.autoPlay) {
          try {
            await audioEl.play();
          } catch {
            // Browsers may block playback that starts after a delay; the Play button stays available.
          }
        }
      } catch (err) {
        if (id !== run.current) return;
        if (err instanceof ApiError && err.code === "CONSENT_REQUIRED") {
          const ok = await requestConsent();
          if (ok && id === run.current) return play(req);
          setState(IDLE);
          return;
        }
        setState((st) => ({
          ...st,
          summary: summary ?? st.summary,
          status: "error",
          error: errorMessage(err),
          retryable: err instanceof ApiError ? err.retryable || err.code === "RATE_LIMITED" : true,
        }));
      }
    },
    [requestConsent],
  );

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el || !el.src) return;
    if (el.paused) void el.play().catch(() => patch({ status: "error", error: "Couldn't start playback. Tap play again.", retryable: false }));
    else el.pause();
  }, [patch]);

  const replay = useCallback(() => {
    const el = audioRef.current;
    if (!el || !el.src) return;
    el.currentTime = 0;
    void el.play().catch(() => undefined);
  }, []);

  const seek = useCallback((t: number) => {
    const el = audioRef.current;
    if (el && Number.isFinite(t)) el.currentTime = t;
  }, []);

  const close = useCallback(() => {
    run.current++;
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    setState(IDLE);
  }, []);

  const retry = useCallback(() => {
    if (state.request) void play(state.request);
  }, [play, state.request]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler("play", () => void audioRef.current?.play());
      ms.setActionHandler("pause", () => audioRef.current?.pause());
      ms.setActionHandler("seekbackward", () => {
        if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10);
      });
      ms.setActionHandler("seekforward", () => {
        if (audioRef.current) audioRef.current.currentTime += 10;
      });
    } catch {
      // Some browsers don't support every action.
    }
  }, []);

  const value = useMemo<PlayerApi>(() => ({ state, play, toggle, replay, seek, close, retry }), [state, play, toggle, replay, seek, close, retry]);

  return (
    <PlayerCtx.Provider value={value}>
      {children}
      <audio
        ref={audioRef}
        preload="auto"
        onPlay={() => patch({ status: "playing" })}
        onPause={(e) => {
          const el = e.currentTarget;
          if (!el.ended && el.src) patch({ status: "paused" });
        }}
        onEnded={() => patch({ status: "ended" })}
        onTimeUpdate={(e) => patch({ currentTime: e.currentTarget.currentTime })}
        onLoadedMetadata={(e) => patch({ duration: e.currentTarget.duration })}
        onDurationChange={(e) => patch({ duration: e.currentTarget.duration })}
        onError={(e) => {
          if (e.currentTarget.getAttribute("src")) patch({ status: "error", error: "The audio couldn't be played. Try again.", retryable: true });
        }}
      />
    </PlayerCtx.Provider>
  );
}
