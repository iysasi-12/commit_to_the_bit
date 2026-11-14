import { useState } from "react";
import { api, errorMessage } from "../api.ts";
import type { AppConfigInfo } from "../types.ts";

const SIGNIN_ERRORS: Record<string, string> = {
  ACCESS_DENIED: "Google sign-in was cancelled.",
  STATE_MISMATCH: "That sign-in link expired or was opened in a different browser. Please try again.",
  GMAIL_SCOPE_MISSING: "VocaMail needs permission to read your Gmail. Sign in again and keep the Gmail box checked.",
  GOOGLE_NOT_CONFIGURED: "Google sign-in isn't set up on this server yet. The app owner needs to add Google OAuth keys.",
  GOOGLE_CONFIG: "Google sign-in is misconfigured on this server. The app owner should check the OAuth client and redirect URI.",
  GMAIL_REAUTH: "Google didn't grant lasting access. Please sign in again.",
  RATE_LIMITED: "Too many sign-in attempts. Wait a minute and try again.",
  GMAIL_UNAVAILABLE: "Couldn't reach Google. Check your connection and try again.",
};

export function SignIn({ config, errorCode, onSignedIn }: { config: AppConfigInfo; errorCode: string | null; onSignedIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(errorCode ? (SIGNIN_ERRORS[errorCode] ?? "Google sign-in didn't work. Please try again.") : null);

  async function demo() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/demo", { method: "POST" });
      onSignedIn();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <div className="card">
        <img src="/icon.svg" alt="" className="signin-logo" />
        <h1>Hear your inbox.</h1>
        <p className="lede">
          VocaMail reads your Gmail, writes a quick AI summary, and plays it in a voice you choose, including your own. The Filter sorts mail into School, Work,
          Transactions and more.
        </p>
        {error && (
          <div className="notice notice-error" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        <div className="stack">
          {config.signIn.google ? (
            <a className="btn btn-lg btn-block google-btn" href="/auth/google/start">
              <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.1 5.5c4.2-3.9 7.2-9.6 7.2-16.9z" />
                <path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z" />
                <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.1-5.5c-2 1.4-4.6 2.2-8.8 2.2-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
              </svg>
              Sign in with Google
            </a>
          ) : (
            <div className="notice small">Google sign-in isn't set up on this server yet. The app owner needs to add Google OAuth keys (see the README).</div>
          )}
          {config.signIn.demo && (
            <button className="btn btn-lg btn-block" onClick={demo} disabled={busy}>
              {busy ? "Starting demo…" : "Try the demo inbox"}
            </button>
          )}
        </div>
        <p className="small muted" style={{ marginTop: 16, marginBottom: 0 }}>
          Read-only Gmail access: the app can't send, delete, or change email. While this app is in Google's testing mode you may see a "Google hasn't verified this
          app" screen; only accounts the owner added as test users can sign in.
        </p>
      </div>
    </main>
  );
}
