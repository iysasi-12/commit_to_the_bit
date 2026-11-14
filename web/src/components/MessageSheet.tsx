import { useEffect, useState } from "react";
import { api, errorMessage } from "../api.ts";
import { Icon } from "../icons.tsx";
import { useApp, usePlayer } from "../state.tsx";
import type { FullMessage, InboxItem } from "../types.ts";
import { avatarColor, initials } from "../util.ts";

export function MessageSheet({ item, onClose }: { item: InboxItem; onClose: () => void }) {
  const { categories } = useApp();
  const { play, state } = usePlayer();
  const [message, setMessage] = useState<FullMessage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ message: FullMessage }>(`/api/messages/${encodeURIComponent(item.id)}`).then(
      (r) => alive && setMessage(r.message),
      (err) => alive && setError(errorMessage(err)),
    );
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [item.id, onClose]);

  const cat = categories?.categories.find((c) => c.id === item.categoryId);
  const busy = state.request?.kind === "message" && state.request.messageId === item.id && (state.status === "summarizing" || state.status === "voicing");

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="msg-subject" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-head">
          <button className="icon-btn" onClick={onClose} aria-label="Back to inbox">
            <Icon name="back" />
          </button>
          {cat && (
            <span className="badge">
              <span className="dot" style={{ background: cat.color }} />
              {cat.name}
            </span>
          )}
        </div>
        <h2 id="msg-subject" style={{ fontSize: "1.3rem", marginTop: 8 }}>
          {item.subject}
        </h2>
        <div className="row" style={{ margin: "10px 0 16px" }}>
          <span className="avatar" style={{ background: avatarColor(item.fromEmail || item.fromName) }} aria-hidden="true">
            {initials(item.fromName)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{item.fromName}</div>
            <div className="small muted">
              {item.fromEmail} · {new Date(item.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
            </div>
          </div>
        </div>

        <button
          className="btn btn-primary btn-lg btn-block"
          onClick={() => void play({ kind: "message", messageId: item.id, label: item.subject })}
          disabled={busy}
        >
          <Icon name="sparkle" /> {busy ? "Working on it…" : "AI Summary of this email"}
        </button>
        <p className="small muted" style={{ textAlign: "center", marginTop: 6 }}>
          AI-written and read aloud by an AI voice. Nothing plays until it's ready.
        </p>

        <div className="card" style={{ marginTop: 12 }}>
          {error && <div className="notice notice-error">{error}</div>}
          {!message && !error && (
            <div className="stack">
              <div className="skeleton" style={{ width: "90%" }} />
              <div className="skeleton" style={{ width: "75%" }} />
              <div className="skeleton" style={{ width: "82%" }} />
            </div>
          )}
          {message && (
            <>
              <div className="message-body">{message.bodyText || message.snippet || "(This email has no text.)"}</div>
              {message.bodyTruncated && <p className="small muted" style={{ marginTop: 10 }}>This email is long; only the first part is shown here. Open Gmail to read all of it.</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
