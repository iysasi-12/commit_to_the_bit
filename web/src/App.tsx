import { useCallback, useEffect, useState } from "react";
import { ApiError, api, errorMessage } from "./api.ts";
import { ConsentSheet } from "./components/ConsentSheet.tsx";
import { DemoNotice } from "./components/DemoNotice.tsx";
import { MessageSheet } from "./components/MessageSheet.tsx";
import { Player } from "./components/Player.tsx";
import { SignIn } from "./components/SignIn.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { FilterPage } from "./pages/FilterPage.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { MailConceptPage } from "./pages/MailConceptPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { VoicePage } from "./pages/VoicePage.tsx";
import { AppProvider, PlayerProvider, useApp, usePlayer } from "./state.tsx";
import type { AppConfigInfo, InboxItem, Me, Tab } from "./types.ts";

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "filter", label: "Filter", icon: "filter" },
  { id: "voice", label: "Voice", icon: "voice" },
  { id: "gmail", label: "Gmail view", icon: "panel" },
  { id: "settings", label: "Settings", icon: "settings" },
];

function readInitialTab(): Tab {
  const hash = window.location.hash.replace("#", "");
  return (TABS.find((t) => t.id === hash)?.id ?? "inbox") as Tab;
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
    // The Gmail view has its own player in the side panel, so the bottom player is hidden there.
    document.documentElement.style.setProperty("--player-h", state.status === "idle" || tab === "gmail" ? "0px" : "250px");
  }, [state.status, tab]);

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
        <div className={tab === "gmail" ? "page page-wide" : "page"}>
          <div className="topbar">
            <div className="brand">
              <img src="/icon.svg" alt="" /> VocaMail
            </div>
          </div>
          {/* The Inbox shows this under its AI Summary button instead, so the button stays at the top. */}
          {tab !== "inbox" && <DemoNotice />}
        </div>
        {tab === "inbox" && <InboxPage onOpen={setOpen} />}
        {tab === "filter" && <FilterPage onOpen={setOpen} />}
        {tab === "voice" && <VoicePage />}
        {tab === "gmail" && <MailConceptPage />}
        {tab === "settings" && <SettingsPage onSignedOut={onSignedOut} />}
      </main>
      <Player hidden={tab === "gmail"} />
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
