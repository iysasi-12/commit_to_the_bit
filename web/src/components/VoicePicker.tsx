import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api.ts";
import { Icon } from "../icons.tsx";
import type { VoicesResponse } from "../types.ts";

/** Loads the person's voices; `select` switches which one reads their summaries. */
export function useVoices() {
  const [data, setData] = useState<VoicesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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

  const select = useCallback(
    async (ref: string) => {
      setSaving(true);
      setError(null);
      try {
        await api("/api/voices/selected", { method: "PUT", body: { ref } });
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setSaving(false);
      }
    },
    [load],
  );

  return { data, error, saving, load, select };
}

function shortName(name: string): string {
  // ElevenLabs names look like "Bella - Professional, Bright, Warm"; keep the first part for menus.
  return name.split(" - ")[0] ?? name;
}

/** A compact dropdown for switching voices without leaving the current screen. */
export function VoicePicker({ label = "Voice", onManage }: { label?: string; onManage?: () => void }) {
  const { data, error, saving, select } = useVoices();
  const mine = (data?.mine ?? []).filter((v) => v.status === "approved" && !(v.madeInDemo && data?.mode === "live"));
  const selected = data?.selected?.ref ?? "";
  const selectedIsListed = mine.some((v) => v.ref === selected) || (data?.stock ?? []).some((v) => `stock:${v.providerVoiceId}` === selected);

  return (
    <div className="voice-picker">
      <label className="voice-picker-row">
        <span className="voice-picker-label">
          <Icon name="voice" /> {label}
        </span>
        <select className="input" value={selected} disabled={!data || saving || data.mode === "unavailable"} onChange={(e) => void select(e.target.value)} aria-label="Choose the voice that reads your summaries">
          {!data && <option value="">Loading voices…</option>}
          {data && !selectedIsListed && (
            <option value={selected} disabled>
              {data.selected?.name ?? (data.mode === "unavailable" ? "Voice service unavailable" : "Choose a voice")}
            </option>
          )}
          {mine.length > 0 && (
            <optgroup label="Your voices">
              {mine.map((v) => (
                <option key={v.ref} value={v.ref}>
                  {v.name}
                  {v.kind === "own" ? " (your voice)" : ""}
                </option>
              ))}
            </optgroup>
          )}
          {data && data.stock.length > 0 && (
            <optgroup label="Ready-made voices">
              {data.stock.map((v) => (
                <option key={v.providerVoiceId} value={`stock:${v.providerVoiceId}`}>
                  {shortName(v.name)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {onManage && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onManage}>
          <Icon name="plus" /> Add or manage voices
        </button>
      )}
      {(error || data?.stockError) && <div className="notice notice-error small">{error ?? data?.stockError}</div>}
    </div>
  );
}
