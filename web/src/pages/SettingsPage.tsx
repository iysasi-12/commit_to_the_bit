import { useRef, useState } from "react";
import { api, errorMessage } from "../api.ts";
import { ConsentDetails } from "../components/ConsentSheet.tsx";
import { Icon } from "../icons.tsx";
import { useApp, usePlayer } from "../state.tsx";
import type { Me, ServiceMode, Settings } from "../types.ts";

function ServiceBadge({ mode }: { mode: ServiceMode }) {
  if (mode === "live") return <span className="badge badge-ai">Live</span>;
  if (mode === "demo") return <span className="badge badge-demo">Demo stand-in</span>;
  return <span className="badge">Not set up</span>;
}

export function SettingsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const { me, setMe, config, signOut, requestConsent } = useApp();
  const { close } = usePlayer();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const timer = useRef<number | null>(null);

  async function save(patch: Partial<Settings>) {
    setError(null);
    try {
      const res = await api<{ user: Me }>("/api/settings", { method: "PATCH", body: patch });
      setMe(res.user);
      setDraft((d) => {
        const next = { ...d };
        for (const k of Object.keys(patch) as Array<keyof Settings>) delete next[k];
        return next;
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /** Sliders update on screen right away and save once the person stops moving them. */
  function saveSoon(patch: Partial<Settings>) {
    setDraft((d) => ({ ...d, ...patch }));
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(patch), 350);
  }

  async function revoke() {
    if (!confirm("Turn off AI features? Saved summaries, audio and the Filter's sorting will be deleted. You can turn it back on later.")) return;
    try {
      close();
      const res = await api<{ user: Me }>("/api/consent", { method: "DELETE" });
      setMe(res.user);
      setNotice("AI features are off and everything they produced was deleted.");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function clearCache() {
    try {
      close();
      const res = await api<{ audioFiles: number }>("/api/account/clear-cache", { method: "POST" });
      setNotice(`Deleted saved summaries and ${res.audioFiles} audio file${res.audioFiles === 1 ? "" : "s"}.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function deleteAccount() {
    if (!confirm("Delete your account and all data? This deletes your voice clone at ElevenLabs, disconnects Gmail, and removes every summary, audio file and setting. This can't be undone.")) return;
    try {
      close();
      const res = await api<{ googleRevoked: boolean; voicesNotDeleted: string[] }>("/api/account", { method: "DELETE" });
      const problems: string[] = [];
      if (!res.googleRevoked) problems.push("Google didn't confirm the disconnect. You can remove access at myaccount.google.com/permissions.");
      if (res.voicesNotDeleted.length) problems.push(`These voices couldn't be deleted at ElevenLabs: ${res.voicesNotDeleted.join(", ")}. Ask the app owner to remove them.`);
      alert(problems.length ? `Your account was deleted.\n\n${problems.join("\n")}` : "Your account and all its data were deleted.");
      onSignedOut();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const s = { ...me.settings, ...draft };

  return (
    <div className="page">
      <h1>Settings</h1>
      {error && (
        <div className="notice notice-error" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      {notice && (
        <div className="notice notice-ok" role="status" style={{ marginBottom: 12 }}>
          {notice}
        </div>
      )}

      <section className="section">
        <h2>Listening</h2>
        <div className="card">
          <div className="toggle-row">
            <div>
              <div style={{ fontWeight: 600 }}>Summary length</div>
              <div className="small muted">Brief is about 30 to 60 seconds of listening.</div>
            </div>
            <div className="segmented" role="group" aria-label="Summary length">
              <button aria-pressed={s.summaryLength === "brief"} onClick={() => void save({ summaryLength: "brief" })}>
                Brief
              </button>
              <button aria-pressed={s.summaryLength === "detailed"} onClick={() => void save({ summaryLength: "detailed" })}>
                Detailed
              </button>
            </div>
          </div>
          <div className="toggle-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <label htmlFor="speed" style={{ fontWeight: 600 }}>
              Speaking speed: {s.speakingSpeed.toFixed(2)}×
            </label>
            <input id="speed" type="range" min={0.8} max={1.2} step={0.05} value={s.speakingSpeed} onChange={(e) => saveSoon({ speakingSpeed: Number(e.target.value) })} />
          </div>
          <div className="toggle-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <label htmlFor="count" style={{ fontWeight: 600 }}>
              Emails per inbox summary: {s.summaryCount}
            </label>
            <input
              id="count"
              type="range"
              min={3}
              max={config.limits.summaryMaxEmails}
              step={1}
              value={s.summaryCount}
              onChange={(e) => saveSoon({ summaryCount: Number(e.target.value) })}
            />
          </div>
          <label className="toggle-row">
            <span>
              <span style={{ fontWeight: 600, display: "block" }}>Play automatically when ready</span>
              <span className="small muted">Only after you tap AI Summary. Turn off to start playback yourself.</span>
            </span>
            <input type="checkbox" className="switch" checked={s.autoPlay} onChange={(e) => void save({ autoPlay: e.target.checked })} />
          </label>
          <label className="toggle-row">
            <span>
              <span style={{ fontWeight: 600, display: "block" }}>Sort new emails automatically</span>
              <span className="small muted">Runs the Filter when new mail arrives.</span>
            </span>
            <input type="checkbox" className="switch" checked={s.autoSort} onChange={(e) => void save({ autoSort: e.target.checked })} />
          </label>
        </div>
      </section>

      <section className="section">
        <h2>Privacy</h2>
        <div className="card stack">
          <div className="row">
            <Icon name="shield" />
            <strong style={{ flex: 1 }}>{me.consent.accepted ? "AI features are on" : "AI features are off"}</strong>
            {me.consent.accepted ? (
              <button className="btn btn-sm btn-danger" onClick={revoke}>
                Turn off
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={() => void requestConsent()}>
                Review and turn on
              </button>
            )}
          </div>
          {me.consent.accepted && me.consent.acceptedAt && (
            <p className="small muted" style={{ margin: 0 }}>
              You agreed on {new Date(me.consent.acceptedAt).toLocaleDateString()}.
            </p>
          )}
          <button className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setShowDetails((v) => !v)} aria-expanded={showDetails}>
            {showDetails ? "Hide" : "Show"} what's shared and stored
          </button>
          {showDetails && <ConsentDetails />}
          <div className="row">
            <button className="btn btn-sm" onClick={clearCache}>
              <Icon name="trash" /> Clear saved summaries and audio
            </button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Deleting removes the copies this app keeps. It can't reach copies made outside the app, such as a screen recording.
          </p>
        </div>
      </section>

      <section className="section">
        <h2>Account</h2>
        <div className="card stack">
          <div>
            <div style={{ fontWeight: 700 }}>{me.name}</div>
            <div className="small muted">{me.isDemo ? "Demo account (sample inbox)" : me.email}</div>
          </div>
          <div className="row">
            <button className="btn" onClick={() => void signOut()}>
              Sign out
            </button>
            <button className="btn btn-danger" onClick={deleteAccount}>
              Delete account and data
            </button>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Services</h2>
        <div className="card status-grid small">
          <span>Gmail</span>
          <span>
            <ServiceBadge mode={me.isDemo ? "demo" : config.services.gmail} /> {me.isDemo ? "Sample inbox" : "Read-only"}
          </span>
          <span>AI summaries</span>
          <span>
            <ServiceBadge mode={config.services.ai} /> {config.aiModel ? `Anthropic ${config.aiModel}` : ""}
          </span>
          <span>Voice</span>
          <span>
            <ServiceBadge mode={config.services.voice} /> {config.voiceModel ? `ElevenLabs ${config.voiceModel}` : ""}
          </span>
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          Inbox Voice works with Gmail through Google's official API. It doesn't read text messages, iMessage, WhatsApp or other apps, and it isn't a CarPlay app. In a car
          you can listen over Bluetooth like any audio.
        </p>
      </section>
    </div>
  );
}
