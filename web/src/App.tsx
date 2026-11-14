import { useCallback, useEffect, useState } from "react";
import { ApiError, api, errorMessage } from "./api.ts";
import { ConsentSheet } from "./components/ConsentSheet.tsx";
import { MessageSheet } from "./components/MessageSheet.tsx";
import { Player } from "./components/Player.tsx";
import { SignIn } from "./components/SignIn.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { FilterPage } from "./pages/FilterPage.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { VoicePage } from "./pages/VoicePage.tsx";
import { AppProvider, PlayerProvider, useApp, usePlayer } from "./state.tsx";
import type { AppConfigInfo, InboxItem, Me, Tab } from "./types.ts";

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "filter", label: "Filter", icon: "filter" },
  { id: "voice", label: "Voice", icon: "voice" },
  { id: "settings", label: "Settings", icon: "settings" },
];

function readInitialTab(): Tab {
  const hash = window.location.hash.replace("#", "");
  return (TABS.find((t) => t.id === hash)?.id ?? "inbox") as Tab;
}

function DemoNotice() {
  const { me, config } = useApp();
  const parts: string[] = [];
  if (me.isDemo) parts.push("sample inbox");
  if (config.services.ai === "demo") parts.push("summaries without AI");
  if (config.services.voice === "demo") parts.push("placeholder audio");
  if (parts.length === 0) return null;
  return (
    <div className="notice notice-warn small" role="note" style={{ marginBottom: 8 }}>
      <strong>Demo mode</strong>
      Using {parts.join(", ")}. {config.services.ai === "demo" || config.services.voice === "demo" ? "Add API keys in .env to switch these to the real services." : ""}
    </div>
  );
}

function Shell({ onSignedOut }: { onSignedOut: () => void }) {
  const [tab, setTab] = useState<Tab>(readInitialTab);
  const [open, setOpen] = useState<InboxItem | null>(null);
  const { state } = usePlayer();
  const closeMessage = useCallback(() => setOpen(null), []);

  useEffect(() => {
    if (window.location.hash !== `#${tab}`) window.history.pushState(null, "", `#${tab}`);
    window.scrollTo({ top: 0 });
  }, [tab]);

  useEffect(() => {
    const onHash = () => setTab(readInitialTab());
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--player-h", state.status === "idle" ? "0px" : "250px");
  }, [state.status]);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <img src="/icon.svg" alt="" /> VocaMail
        </div>
        {TABS.map((t) => (
          <button key={t.id} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} /> {t.label}
          </button>
        ))}
      </nav>
      <main className="main">
        <div className="page">
          <div className="topbar">
            <div className="brand">
              <img src="/icon.svg" alt="" /> VocaMail
            </div>
          </div>
          <DemoNotice />
        </div>
        {tab === "inbox" && <InboxPage onOpen={setOpen} />}
        {tab === "filter" && <FilterPage onOpen={setOpen} />}
        {tab === "voice" && <VoicePage />}
        {tab === "settings" && <SettingsPage onSignedOut={onSignedOut} />}
      </main>
      <Player />
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <button key={t.id} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} />
            {t.label}
          </button>
        ))}
      </nav>
      {open && <MessageSheet item={open} onClose={closeMessage} />}
      <ConsentSheet />
    </div>
  );
}

export function App() {
  const [config, setConfig] = useState<AppConfigInfo | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [fatal, setFatal] = useState<string | null>(null);
  const [signinError] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("signin_error");
    if (code) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    return code;
  });

  const loadMe = useCallback(async () => {
    try {
      const res = await api<{ user: Me }>("/api/me");
      setMe(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.code === "UNAUTHENTICATED") setMe(null);
      else setFatal(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    api<AppConfigInfo>("/api/config").then(setConfig, (err) => setFatal(errorMessage(err)));
    void loadMe();
  }, [loadMe]);

  const onSignedOut = useCallback(() => setMe(null), []);

  if (fatal) {
    return (
      <main className="signin">
        <div className="card">
          <h1>Can't load VocaMail</h1>
          <p className="notice notice-error">{fatal}</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </main>
    );
  }
  if (!config || me === undefined) {
    return (
      <main className="signin" aria-busy="true">
        <img src="/icon.svg" alt="Loading VocaMail" className="signin-logo" />
      </main>
    );
  }
  if (me === null) return <SignIn config={config} errorCode={signinError} onSignedIn={() => void loadMe()} />;

  return (
    <AppProvider key={me.id} config={config} initialMe={me} onSignedOut={onSignedOut}>
      <PlayerProvider>
        <Shell onSignedOut={onSignedOut} />
      </PlayerProvider>
    </AppProvider>
  );
}
