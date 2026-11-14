import { useState } from "react";
import { api, errorMessage } from "../api.ts";
import { Icon } from "../icons.tsx";
import { useApp } from "../state.tsx";
import type { Me } from "../types.ts";

export function ConsentDetails() {
  const { config } = useApp();
  return (
    <ul className="stack small" style={{ paddingLeft: 18, margin: "8px 0" }}>
      <li>
        <strong>Gmail is read-only.</strong> The app can read your inbox but can't send, delete, or change any email.
      </li>
      <li>
        <strong>Summaries:</strong> when you ask for one, the sender, subject, date, and text of those emails are sent to Anthropic's Claude AI to write it.
      </li>
      <li>
        <strong>Filter:</strong> to sort emails into categories, only the sender, subject, and Gmail's short preview are sent to Claude.
      </li>
      <li>
        <strong>Voice:</strong> the summary text is sent to ElevenLabs to turn it into speech.
      </li>
      <li>
        <strong>What's kept:</strong> summaries and audio are stored privately for up to {config.limits.cacheTtlHours} hours so replays are instant and free, then deleted. Email
        text itself is never saved. You can clear everything any time in Settings.
      </li>
      <li>
        <strong>AI can be wrong.</strong> Summaries can miss or misread details. Check the original email for anything important.
      </li>
    </ul>
  );
}

export function ConsentSheet() {
  const { consentOpen, resolveConsent, config, setMe } = useApp();
  const [agree, setAgree] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!consentOpen) return null;

  async function accept() {
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ user: Me }>("/api/consent", { method: "POST", body: { accept: true, version: config.consentVersion } });
      setMe(res.user);
      resolveConsent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className="sheet">
        <div className="sheet-head">
          <h2 id="consent-title" className="row" style={{ gap: 8 }}>
            <Icon name="shield" /> Before the AI reads your email
          </h2>
        </div>
        <p className="lede">Here's exactly what happens when you use AI summaries and the Filter.</p>
        <ConsentDetails />
        <label className="check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>I understand and agree to my email content being processed by Anthropic and ElevenLabs as described above.</span>
        </label>
        {error && <div className="notice notice-error">{error}</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary btn-lg" disabled={!agree || saving} onClick={accept}>
            {saving ? "Saving…" : "Agree and continue"}
          </button>
          <button className="btn btn-ghost" onClick={() => resolveConsent(false)}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
