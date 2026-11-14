import { useState } from "react";
import { Icon } from "../icons.tsx";
import { usePlayer } from "../state.tsx";
import { clock } from "../util.ts";

function statusText(status: string, cached: { summary: boolean; audio: boolean }): string {
  switch (status) {
    case "summarizing":
      return "Reading your emails and writing a summary…";
    case "voicing":
      return "Turning the summary into speech…";
    case "ready":
      return cached.audio ? "Ready (saved copy, no new charge)" : "Ready to play";
    case "playing":
      return "Playing";
    case "paused":
      return "Paused";
    case "ended":
      return "Finished";
    default:
      return "";
  }
}

export function Player() {
  const { state, toggle, replay, seek, close, retry } = usePlayer();
  const [showText, setShowText] = useState(false);
  if (state.status === "idle") return null;

  const busy = state.status === "summarizing" || state.status === "voicing";
  const canPlay = Boolean(state.audio) && !busy;
  const playing = state.status === "playing";
  const title = state.summary?.title ?? state.request?.label ?? "Summary";
  const demoAudio = state.audio?.voiceMode === "demo";
  const demoText = state.summary?.aiMode === "demo";

  return (
    <section className="player" aria-label="Summary player">
      <div className="player-inner">
        <div className="player-top">
          {busy ? (
            <div className="icon-btn primary" aria-hidden="true">
              <Icon name="sparkle" />
            </div>
          ) : (
            <button className="icon-btn primary" onClick={toggle} disabled={!canPlay} aria-label={playing ? "Pause" : "Play"}>
              <Icon name={playing ? "pause" : "play"} />
            </button>
          )}
          <div className="player-meta">
            <div className="player-title">{title}</div>
            <div className="player-status" role="status" aria-live="polite">
              {state.status === "error" ? <span style={{ color: "var(--danger)" }}>{state.error}</span> : statusText(state.status, state.cached)}
            </div>
          </div>
          {canPlay && (
            <button className="icon-btn" onClick={replay} aria-label="Replay from the start">
              <Icon name="replay" />
            </button>
          )}
          <button className="icon-btn" onClick={close} aria-label="Close player">
            <Icon name="close" />
          </button>
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

        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          <span className="badge badge-ai" title="This summary was written by AI and is read by a synthetic voice.">
            <Icon name="sparkle" /> AI-generated{state.audio?.voiceName ? ` · voice: ${state.audio.voiceName}` : ""}
          </span>
          {demoText && <span className="badge badge-demo">Demo summary (no AI)</span>}
          {demoAudio && <span className="badge badge-demo">Demo audio (placeholder tones)</span>}
          <span className="spacer" />
          {state.status === "error" && state.retryable && (
            <button className="btn btn-sm" onClick={retry}>
              Try again
            </button>
          )}
          {state.summary && (
            <button className="btn btn-sm btn-ghost" onClick={() => setShowText((v) => !v)} aria-expanded={showText}>
              {showText ? "Hide text" : "Show text"} <Icon name={showText ? "chevronDown" : "chevronUp"} />
            </button>
          )}
        </div>

        {showText && state.summary && (
          <div className="transcript">
            {state.summary.text}
            <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
              Covers {state.summary.messageCount} email{state.summary.messageCount === 1 ? "" : "s"}.
              {state.summary.truncatedCount > 0 && ` ${state.summary.truncatedCount} long email${state.summary.truncatedCount === 1 ? " was" : "s were"} shortened first.`} AI can make
              mistakes, so check the original email for anything important.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
