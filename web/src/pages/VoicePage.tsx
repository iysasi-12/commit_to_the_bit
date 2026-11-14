import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage } from "../api.ts";
import { Icon } from "../icons.tsx";
import { useApp } from "../state.tsx";
import type { AudioInfo, LibraryVoice, MyVoice, VoicesResponse } from "../types.ts";
import { VoiceSetup } from "./VoiceSetup.tsx";

function useSamplePlayer() {
  const el = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const play = useCallback(async (key: string, url: string) => {
    if (!el.current) el.current = new Audio();
    const a = el.current;
    if (playing === key && !a.paused) {
      a.pause();
      setPlaying(null);
      return;
    }
    a.src = url;
    a.onended = () => setPlaying(null);
    try {
      await a.play();
      setPlaying(key);
    } catch {
      setPlaying(null);
    }
  }, [playing]);
  useEffect(() => () => el.current?.pause(), []);
  return { playing, play };
}

export function VoicePage() {
  const { config } = useApp();
  const [data, setData] = useState<VoicesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [library, setLibrary] = useState<{ voices: LibraryVoice[]; hasMore: boolean } | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const sample = useSamplePlayer();

  const load = useCallback(async () => {
    try {
      setData(await api<VoicesResponse>("/api/voices"));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function select(ref: string) {
    setBusy(ref);
    setError(null);
    try {
      await api("/api/voices/selected", { method: "PUT", body: { ref } });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function searchLibrary(e?: FormEvent) {
    e?.preventDefault();
    setLibraryLoading(true);
    setLibraryError(null);
    try {
      setLibrary(await api(`/api/voices/library?search=${encodeURIComponent(search)}`));
    } catch (err) {
      setLibraryError(errorMessage(err));
    } finally {
      setLibraryLoading(false);
    }
  }

  async function addLibrary(v: LibraryVoice) {
    setBusy(v.providerVoiceId);
    setLibraryError(null);
    try {
      await api("/api/voices/library", { method: "POST", body: { publicOwnerId: v.publicOwnerId, providerVoiceId: v.providerVoiceId, name: v.name } });
      setNotice(`"${v.name}" added and selected.`);
      await load();
    } catch (err) {
      setLibraryError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(v: MyVoice) {
    const msg =
      v.kind === "own"
        ? "Delete your voice? This deletes the clone at ElevenLabs, stops it from being used, and removes all saved audio made with it. Audio someone already copied off the app (for example with a screen recorder) can't be recalled."
        : `Remove "${v.name}" from your voices?`;
    if (!confirm(msg)) return;
    setBusy(v.id);
    setError(null);
    try {
      await api(`/api/voices/${v.id}`, { method: "DELETE" });
      setNotice(v.kind === "own" ? "Your voice was deleted at ElevenLabs and its saved audio was removed." : `"${v.name}" was removed.`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteRecording(v: MyVoice) {
    setBusy(v.id);
    try {
      await api(`/api/voices/${v.id}/recording`, { method: "DELETE" });
      setNotice("Your kept recording was deleted.");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function previewMine(v: MyVoice) {
    setBusy(v.id);
    try {
      const res = await api<{ audio: AudioInfo }>(`/api/voices/${v.id}/preview`, { method: "POST" });
      await sample.play(v.id, res.audio.url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const own = data?.mine.find((v) => v.kind === "own") ?? null;
  const libraryMine = data?.mine.filter((v) => v.kind === "library") ?? [];
  const selectedRef = data?.selected?.ref ?? null;
  const unavailable = data?.mode === "unavailable";

  return (
    <div className="page">
      <h1>Voice</h1>
      <p className="lede">Choose who reads your summaries: a ready-made voice, one from the ElevenLabs Voice Library, or your own.</p>

      {config.services.voice === "demo" && (
        <div className="notice notice-warn" style={{ marginBottom: 12 }}>
          <strong>Demo voices</strong>
          No ElevenLabs key is set, so these are placeholders and audio is a simple tone pattern. Add ELEVENLABS_API_KEY to hear real voices.
        </div>
      )}
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

      <div className="card hero">
        <div className="small muted" style={{ color: "var(--ink-2)" }}>
          Now reading your summaries
        </div>
        <h2 style={{ fontSize: "1.4rem" }}>{data?.selected?.name ?? (unavailable ? "No voice service" : "Loading…")}</h2>
        <span className="badge badge-ai">
          <Icon name="sparkle" /> AI voice
          {data?.selected?.kind === "own" ? " · your clone" : data?.selected?.kind === "library" ? " · Voice Library" : ""}
        </span>
      </div>

      <section className="section" aria-labelledby="own-h">
        <div className="section-head">
          <h2 id="own-h">Your own voice</h2>
        </div>
        {own ? (
          <div className={`voice-item${selectedRef === own.ref ? " selected" : ""}`}>
            <div className="info">
              <div className="name">{own.name}</div>
              <div className="desc">
                {own.status === "preview" ? "Waiting for your approval" : "Approved"}
                {own.recordingKept ? " · recording kept on server" : " · recording discarded"}
              </div>
            </div>
            {own.status === "preview" ? (
              <button className="btn btn-sm btn-primary" onClick={() => setSetupOpen(true)}>
                Review
              </button>
            ) : (
              <>
                <button className="icon-btn" onClick={() => void previewMine(own)} disabled={busy === own.id} aria-label="Play a sample of your voice">
                  <Icon name={sample.playing === own.id ? "pause" : "play"} />
                </button>
                {selectedRef !== own.ref && (
                  <button className="btn btn-sm" onClick={() => void select(own.ref)} disabled={busy === own.ref}>
                    Use
                  </button>
                )}
              </>
            )}
            <button className="icon-btn" onClick={() => void remove(own)} disabled={busy === own.id} aria-label="Delete your voice">
              <Icon name="trash" />
            </button>
          </div>
        ) : (
          <div className="card">
            <p style={{ marginTop: 0 }}>Hear your summaries in your own voice. Takes about 2 minutes: agree, read a short script, preview, approve.</p>
            <button className="btn btn-primary" onClick={() => setSetupOpen(true)} disabled={unavailable}>
              <Icon name="mic" /> Create my voice
            </button>
          </div>
        )}
        {own?.recordingKept && (
          <button className="btn btn-sm btn-ghost" style={{ marginTop: 8 }} onClick={() => void deleteRecording(own)}>
            <Icon name="trash" /> Delete my kept recording
          </button>
        )}
      </section>

      <section className="section" aria-labelledby="stock-h">
        <div className="section-head">
          <h2 id="stock-h">Ready-made voices</h2>
        </div>
        {data?.stockError && <div className="notice notice-error">{data.stockError}</div>}
        {!data && <div className="skeleton" style={{ height: 60 }} />}
        <ul className="voice-list">
          {data?.stock.map((v) => {
            const ref = `stock:${v.providerVoiceId}`;
            const selected = selectedRef === ref;
            const labels = Object.values(v.labels).filter(Boolean).slice(0, 3).join(" · ");
            return (
              <li key={v.providerVoiceId} className={`voice-item${selected ? " selected" : ""}`}>
                {v.previewUrl ? (
                  <button className="icon-btn" onClick={() => void sample.play(ref, v.previewUrl!)} aria-label={`Play a sample of ${v.name}`}>
                    <Icon name={sample.playing === ref ? "pause" : "play"} />
                  </button>
                ) : (
                  <span className="icon-btn" aria-hidden="true" style={{ opacity: 0.4 }}>
                    <Icon name="voice" />
                  </span>
                )}
                <div className="info">
                  <div className="name">{v.name}</div>
                  <div className="desc">{labels || v.description || "ElevenLabs voice"}</div>
                </div>
                {selected ? (
                  <span className="badge badge-ai">
                    <Icon name="check" /> In use
                  </span>
                ) : (
                  <button className="btn btn-sm" onClick={() => void select(ref)} disabled={busy === ref}>
                    Use
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="section" aria-labelledby="lib-h">
        <div className="section-head">
          <h2 id="lib-h">Voice Library</h2>
        </div>
        <p className="small muted">
          Community voices shared on ElevenLabs. Adding one copies it into this app's ElevenLabs account. Using library voices through the API may need a paid
          ElevenLabs plan, and some carry their creator's terms.
        </p>
        {libraryMine.length > 0 && (
          <ul className="voice-list" style={{ marginBottom: 12 }}>
            {libraryMine.map((v) => (
              <li key={v.id} className={`voice-item${selectedRef === v.ref ? " selected" : ""}`}>
                <div className="info">
                  <div className="name">{v.name}</div>
                  <div className="desc">Added from the Voice Library</div>
                </div>
                {selectedRef === v.ref ? (
                  <span className="badge badge-ai">
                    <Icon name="check" /> In use
                  </span>
                ) : (
                  <button className="btn btn-sm" onClick={() => void select(v.ref)}>
                    Use
                  </button>
                )}
                <button className="icon-btn" onClick={() => void remove(v)} aria-label={`Remove ${v.name}`}>
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="row" onSubmit={searchLibrary} role="search">
          <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Search: calm, British, narrator…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search the Voice Library" />
          <button className="btn" disabled={libraryLoading || unavailable}>
            <Icon name="search" /> {libraryLoading ? "Searching…" : "Search"}
          </button>
        </form>
        {libraryError && (
          <div className="notice notice-error" role="alert" style={{ marginTop: 10 }}>
            {libraryError}
          </div>
        )}
        {library && (
          <ul className="voice-list" style={{ marginTop: 10 }}>
            {library.voices.length === 0 && <li className="notice">No voices matched. Try another word.</li>}
            {library.voices.map((v) => {
              const key = `lib:${v.providerVoiceId}`;
              const desc = [v.gender, v.age, v.accent, v.useCase].filter(Boolean).join(" · ") || v.description;
              return (
                <li key={key} className="voice-item">
                  {v.previewUrl ? (
                    <button className="icon-btn" onClick={() => void sample.play(key, v.previewUrl!)} aria-label={`Play a sample of ${v.name}`}>
                      <Icon name={sample.playing === key ? "pause" : "play"} />
                    </button>
                  ) : (
                    <span className="icon-btn" aria-hidden="true" style={{ opacity: 0.4 }}>
                      <Icon name="voice" />
                    </span>
                  )}
                  <div className="info">
                    <div className="name">{v.name}</div>
                    <div className="desc">{desc}</div>
                  </div>
                  <button className="btn btn-sm" onClick={() => void addLibrary(v)} disabled={busy === v.providerVoiceId}>
                    <Icon name="plus" /> Add
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {setupOpen && (
        <VoiceSetup
          existing={own}
          onClose={() => {
            setSetupOpen(false);
            void load();
          }}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}
