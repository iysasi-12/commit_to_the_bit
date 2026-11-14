import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api.ts";
import { statusText } from "../components/Player.tsx";
import { VoicePicker } from "../components/VoicePicker.tsx";
import { Icon } from "../icons.tsx";
import { goTo } from "../nav.ts";
import { useApp, usePlayer } from "../state.tsx";
import type { FullMessage, InboxItem } from "../types.ts";
import { avatarColor, clock, initials, shortTime } from "../util.ts";

/** Compact playback controls that live inside the side panel. */
function PanelPlayer() {
  const { state, toggle, replay, seek, retry } = usePlayer();
  if (state.status === "idle") {
    return <p className="small muted mf-panel-hint">Pick a voice, then tap a summary button. Nothing plays until it's ready.</p>;
  }
  const busy = state.status === "summarizing" || state.status === "voicing";
  const canPlay = Boolean(state.audio) && !busy;
  const playing = state.status === "playing";
  return (
    <div className="mf-panel-player" aria-label="Summary player">
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <button className="icon-btn primary" onClick={toggle} disabled={!canPlay} aria-label={playing ? "Pause" : "Play"}>
          <Icon name={busy ? "sparkle" : playing ? "pause" : "play"} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="player-title">{state.summary?.title ?? state.request?.label}</div>
          <div className="player-status" role="status" aria-live="polite">
            {state.status === "error" ? <span style={{ color: "var(--danger)" }}>{state.error}</span> : statusText(state.status, state.cached)}
          </div>
        </div>
        {canPlay && (
          <button className="icon-btn" onClick={replay} aria-label="Replay from the start">
            <Icon name="replay" />
          </button>
        )}
      </div>
      {busy && (
        <div className="progress indeterminate" style={{ marginTop: 10 }} aria-hidden="true">
          <div />
        </div>
      )}
      {canPlay && (
        <div className="player-scrub">
          <span>{clock(state.currentTime)}</span>
          <input
            type="range"
            min={0}
            max={Number.isFinite(state.duration) && state.duration > 0 ? state.duration : 0}
            step={0.1}
            value={state.currentTime}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Playback position"
          />
          <span>{clock(state.duration)}</span>
        </div>
      )}
      {state.status === "error" && state.retryable && (
        <button className="btn btn-sm" onClick={retry} style={{ marginTop: 8 }}>
          Try again
        </button>
      )}
      {state.summary && <div className="transcript mf-transcript">{state.summary.text}</div>}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <span className="badge badge-ai">
          <Icon name="sparkle" /> AI-generated{state.audio?.voiceName ? ` · ${state.audio.voiceName.split(" - ")[0]}` : ""}
        </span>
        {state.summary?.aiMode === "demo" && <span className="badge badge-demo">Demo summary</span>}
        {state.audio?.voiceMode === "demo" && <span className="badge badge-demo">Demo audio</span>}
      </div>
    </div>
  );
}

/**
 * Concept: Inbox Voice as a side panel inside a Gmail-style mail app. It's a mock-up of the
 * layout, but every button uses the real app: the person's real inbox, voices and summaries.
 */
export function MailConceptPage() {
  const { inbox, categories, me, loadInbox } = useApp();
  const { play, state } = usePlayer();
  const [openId, setOpenId] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [message, setMessage] = useState<FullMessage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cats = categories?.categories ?? [];
  const byId = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of inbox?.messages ?? []) if (x.categoryId) m.set(x.categoryId, (m.get(x.categoryId) ?? 0) + 1);
    return m;
  }, [inbox]);
  const items = (inbox?.messages ?? []).filter((m) => (label ? m.categoryId === label : true));
  const open: InboxItem | null = inbox?.messages.find((m) => m.id === openId) ?? null;
  const unread = inbox?.messages.filter((m) => m.unread).length ?? 0;
  const busy = state.status === "summarizing" || state.status === "voicing";
  const currentLabel = label ? byId.get(label) : undefined;

  useEffect(() => {
    if (!openId) {
      setMessage(null);
      return;
    }
    let alive = true;
    setError(null);
    api<{ message: FullMessage }>(`/api/messages/${encodeURIComponent(openId)}`).then(
      (r) => alive && setMessage(r.message),
      (err) => alive && setError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, [openId]);

  return (
    <div className="page page-wide">
      <h1>Gmail view</h1>
      <p className="lede">How Inbox Voice could look built into your mail app, as a side panel next to your email.</p>
      <div className="notice notice-warn small" role="note" style={{ marginBottom: 14 }}>
        <strong>Concept preview</strong>
        This is a mock-up of the layout inside Inbox Voice, not Gmail itself. The buttons are real: they use {me.isDemo ? "the sample inbox" : "your Gmail"}, your voices, and
        real summaries. Putting it inside Gmail would be built as a Gmail add-on.
      </div>

      <div className="mail-frame">
        <header className="mf-top">
          <span className="icon-btn mf-flat" aria-hidden="true">
            <Icon name="menu" />
          </span>
          <span className="mf-wordmark">Mail</span>
          <input className="input mf-search" placeholder="Search mail" aria-label="Search mail (not active in this preview)" disabled />
          <span className="avatar mf-avatar" style={{ background: avatarColor(me.email || me.name) }} aria-hidden="true">
            {initials(me.name)}
          </span>
        </header>

        <div className="mf-body">
          <nav className="mf-rail" aria-label="Mailboxes">
            <span className="btn mf-compose" aria-disabled="true">
              <Icon name="edit" /> Compose
            </span>
            <button
              className={`mf-rail-item${label === null ? " on" : ""}`}
              onClick={() => {
                setLabel(null);
                setOpenId(null);
              }}
            >
              <Icon name="inbox" /> <span>Inbox</span> <span className="mf-count">{unread || ""}</span>
            </button>
            <span className="mf-rail-item off" aria-disabled="true">
              <Icon name="star" /> <span>Starred</span>
            </span>
            <span className="mf-rail-item off" aria-disabled="true">
              <Icon name="send" /> <span>Sent</span>
            </span>
            <div className="mf-rail-head">Labels (sorted by AI)</div>
            {cats.map((c) => (
              <button
                key={c.id}
                className={`mf-rail-item${label === c.id ? " on" : ""}`}
                onClick={() => {
                  setLabel(c.id);
                  setOpenId(null);
                }}
              >
                <span className="dot" style={{ background: c.color }} /> <span>{c.name}</span> <span className="mf-count">{counts.get(c.id) || ""}</span>
              </button>
            ))}
          </nav>

          <section className="mf-main" aria-label={open ? "Open email" : "Email list"}>
            {!open && (
              <>
                <div className="mf-toolbar">
                  <button className="icon-btn mf-flat" onClick={() => void loadInbox(true)} aria-label="Refresh">
                    <Icon name="refresh" />
                  </button>
                  <span className="small muted">{currentLabel ? currentLabel.name : "Inbox"}</span>
                </div>
                {!inbox && <div className="mf-empty">Loading…</div>}
                {inbox && items.length === 0 && <div className="mf-empty">No emails here.</div>}
                <ul className="mf-list">
                  {items.map((m) => {
                    const cat = m.categoryId ? byId.get(m.categoryId) : undefined;
                    return (
                      <li key={m.id}>
                        <button className={`mf-row${m.unread ? " unread" : ""}`} onClick={() => setOpenId(m.id)}>
                          <span className="mf-from">{m.fromName}</span>
                          <span className="mf-subject">
                            {cat && (
                              <span className="badge mf-label">
                                <span className="dot" style={{ background: cat.color }} />
                                {cat.name}
                              </span>
                            )}
                            <span className="mf-subject-text">{m.subject}</span>
                            <span className="mf-snippet"> – {m.snippet}</span>
                          </span>
                          <span className="mf-time">{shortTime(m.date)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {open && (
              <article className="mf-read">
                <button className="btn btn-sm btn-ghost" onClick={() => setOpenId(null)}>
                  <Icon name="back" /> Back
                </button>
                <h2 className="mf-read-subject">{open.subject}</h2>
                <div className="row" style={{ margin: "8px 0 14px" }}>
                  <span className="avatar" style={{ background: avatarColor(open.fromEmail || open.fromName) }} aria-hidden="true">
                    {initials(open.fromName)}
                  </span>
                  <div>
                    <div style={{ fontWeight: 700 }}>{open.fromName}</div>
                    <div className="small muted">{open.fromEmail}</div>
                  </div>
                </div>
                {error && <div className="notice notice-error">{error}</div>}
                <div className="message-body">{message ? message.bodyText || message.snippet : "Loading…"}</div>
              </article>
            )}
          </section>

          <aside className="mf-addon" aria-label="Inbox Voice side panel">
            <div className="mf-addon-head">
              <img src="/icon.svg" alt="" /> Inbox Voice
            </div>
            <VoicePicker label="Voice" onManage={() => goTo("voice")} />
            {open ? (
              <div className="stack">
                <div className="small muted">This email</div>
                <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void play({ kind: "message", messageId: open.id, label: open.subject })}>
                  <Icon name="sparkle" /> AI Summary of this email
                </button>
              </div>
            ) : (
              <div className="stack">
                {currentLabel ? (
                  <button
                    className="btn btn-primary btn-block"
                    disabled={busy || (counts.get(currentLabel.id) ?? 0) === 0}
                    onClick={() => void play({ kind: "category", categoryId: currentLabel.id, label: `Your ${currentLabel.name} emails` })}
                  >
                    <Icon name="sparkle" /> AI Summary of {currentLabel.name}
                  </button>
                ) : (
                  <button className="btn btn-primary btn-block" disabled={busy || !inbox?.messages.length} onClick={() => void play({ kind: "inbox", label: "Your latest emails" })}>
                    <Icon name="sparkle" /> AI Summary of my inbox
                  </button>
                )}
                {!currentLabel && cats.some((c) => (counts.get(c.id) ?? 0) > 0) && (
                  <>
                    <div className="small muted">Or just one label</div>
                    <div className="row" style={{ gap: 6 }}>
                      {cats
                        .filter((c) => (counts.get(c.id) ?? 0) > 0)
                        .map((c) => (
                          <button
                            key={c.id}
                            className="chip"
                            disabled={busy}
                            onClick={() => void play({ kind: "category", categoryId: c.id, label: `Your ${c.name} emails` })}
                          >
                            <span className="dot" style={{ background: c.color, width: 8, height: 8, borderRadius: "50%", display: "inline-block" }} />
                            {c.name} <span className="count">{counts.get(c.id)}</span>
                          </button>
                        ))}
                    </div>
                  </>
                )}
              </div>
            )}
            <PanelPlayer />
          </aside>
        </div>
      </div>
    </div>
  );
}
